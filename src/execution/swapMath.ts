/**
 * Solana DEX swap math, computed from real on-chain pool state instead of
 * trusting Jupiter's quote. Covers the 4 core architectures:
 *   1. Constant Product AMM   (Raydium AMM v4, Orca V2)
 *   2. Concentrated Liquidity (Orca Whirlpool, Raydium CLMM)
 *   3. Bin-based Liquidity    (Meteora DLMM)
 *   4. Central Limit Order Book (Phoenix, OpenBook)
 *
 * Each class implements both swap directions (USDC->SOL and SOL->USDC),
 * since a cross-DEX round trip needs to buy on one venue and sell on another.
 */

export interface SwapResult {
  amountOut: number;
  feePaid: number;
  executionPrice: number; // USDC per SOL, regardless of swap direction
  newPoolPrice: number;
}

export interface LimitOrder {
  price: number;
  solQuantity: number;
}

export interface DLMMBin {
  binId: number;
  price: number;
  reserveX: number; // SOL available to sell to buyers
  reserveY: number; // USDC available to buy SOL from sellers
}

// ============================================================================
// 1. Constant Product AMM (Raydium AMM v4 / Orca V2) — invariant: x * y = k
// ============================================================================

export class ConstantProductPool {
  constructor(
    public reserveSOL: number,
    public reserveUSDC: number,
    public feeRate: number,
  ) {}

  swapUSDCForSOL(amountInUSDC: number): SwapResult {
    const fee = amountInUSDC * this.feeRate;
    const netUSDC = amountInUSDC - fee;

    const k = this.reserveSOL * this.reserveUSDC;
    const newReserveUSDC = this.reserveUSDC + netUSDC;
    const newReserveSOL = k / newReserveUSDC;
    const solOut = this.reserveSOL - newReserveSOL;

    return {
      amountOut: solOut,
      feePaid: fee,
      executionPrice: netUSDC / solOut,
      newPoolPrice: newReserveUSDC / newReserveSOL,
    };
  }

  swapSOLForUSDC(amountInSOL: number): SwapResult {
    const fee = amountInSOL * this.feeRate;
    const netSOL = amountInSOL - fee;

    const k = this.reserveSOL * this.reserveUSDC;
    const newReserveSOL = this.reserveSOL + netSOL;
    const newReserveUSDC = k / newReserveSOL;
    const usdcOut = this.reserveUSDC - newReserveUSDC;

    return {
      amountOut: usdcOut,
      feePaid: fee,
      executionPrice: usdcOut / netSOL,
      newPoolPrice: newReserveUSDC / newReserveSOL,
    };
  }
}

// ============================================================================
// 2. Concentrated Liquidity AMM (Orca Whirlpool / Raydium CLMM)
// Invariant within an active tick range: x_v * y_v = L^2
// ============================================================================

export class CLMMPool {
  // decimalsAdjustment = 10^(decimalsOfSOL - decimalsOfUSDC) for a real pool
  // (e.g. 1000 for SOL/USDC), or 1 for a synthetic/equal-decimals example.
  // Needed because `sqrtPrice`/`liquidity` are given in human, decimals-
  // adjusted units, but a tick index always maps to a RAW base-unit ratio
  // via 1.0001^tick -- without this factor, tickToSqrtPrice returns a value
  // on a completely different scale than currSqrtP, and any trade that
  // actually crosses a real initialized tick produces a nonsensical result.
  constructor(
    public sqrtPrice: number,
    public currentTick: number,
    public liquidity: number,
    public tickSpacing: number,
    public feeRate: number,
    public tickArray: Map<number, number>, // tickIndex -> liquidityNet
    public decimalsAdjustment: number = 1,
  ) {}

  private tickToSqrtPrice(tick: number): number {
    return Math.pow(1.0001, tick / 2) * Math.sqrt(this.decimalsAdjustment);
  }

  swapUSDCForSOL(amountInUSDC: number): SwapResult {
    const fee = amountInUSDC * this.feeRate;
    const netIn = amountInUSDC - fee;
    let remainingIn = netIn;
    let totalSOLOut = 0;

    let currSqrtP = this.sqrtPrice;
    let currL = this.liquidity;
    let currTick = this.currentTick;

    const sortedTicks = Array.from(this.tickArray.keys())
      .filter((t) => t > currTick)
      .sort((a, b) => a - b);

    let tickPointer = 0;

    while (remainingIn > 0) {
      const nextTick =
        tickPointer < sortedTicks.length
          ? sortedTicks[tickPointer]
          : currTick + this.tickSpacing * 100;

      const nextSqrtP = this.tickToSqrtPrice(nextTick);
      const maxInForThisRange = currL * (nextSqrtP - currSqrtP);

      if (remainingIn <= maxInForThisRange) {
        const finalSqrtP = currSqrtP + remainingIn / currL;
        // Numerically stable form of currL*(1/currSqrtP - 1/finalSqrtP).
        // That form subtracts two nearly-identical large reciprocals when
        // remainingIn is tiny relative to currL (the common case for a real
        // pool and a modest trade) -- catastrophic cancellation, losing
        // almost all precision. Since finalSqrtP - currSqrtP is EXACTLY
        // remainingIn/currL by construction, out = L*(finalSqrtP-currSqrtP)
        // /(currSqrtP*finalSqrtP) simplifies to remainingIn/(currSqrtP*finalSqrtP),
        // which never subtracts two large near-equal values.
        totalSOLOut += remainingIn / (currSqrtP * finalSqrtP);
        currSqrtP = finalSqrtP;
        remainingIn = 0;
      } else {
        // Same stabilization: maxInForThisRange already equals
        // currL*(nextSqrtP-currSqrtP), so dividing it by (currSqrtP*nextSqrtP)
        // is algebraically identical to currL*(1/currSqrtP - 1/nextSqrtP)
        // without ever forming that subtraction.
        totalSOLOut += maxInForThisRange / (currSqrtP * nextSqrtP);
        remainingIn -= maxInForThisRange;
        currSqrtP = nextSqrtP;
        currL += this.tickArray.get(nextTick) || 0;
        currTick = nextTick;
        tickPointer++;
      }

      if (currL <= 0) {
        throw new Error("Pool out of liquidity in range");
      }
    }

    return {
      amountOut: totalSOLOut,
      feePaid: fee,
      executionPrice: netIn / totalSOLOut,
      newPoolPrice: Math.pow(currSqrtP, 2),
    };
  }

  swapSOLForUSDC(amountInSOL: number): SwapResult {
    const fee = amountInSOL * this.feeRate;
    const netIn = amountInSOL - fee;
    let remainingIn = netIn;
    let totalUSDCOut = 0;

    let currSqrtP = this.sqrtPrice;
    let currL = this.liquidity;
    let currTick = this.currentTick;

    // Selling SOL pushes price DOWN, so walk ticks below current, descending.
    const sortedTicks = Array.from(this.tickArray.keys())
      .filter((t) => t < currTick)
      .sort((a, b) => b - a);

    let tickPointer = 0;

    while (remainingIn > 0) {
      const nextTick =
        tickPointer < sortedTicks.length
          ? sortedTicks[tickPointer]
          : currTick - this.tickSpacing * 100;

      const nextSqrtP = this.tickToSqrtPrice(nextTick);
      // Max SOL (x) input to push price down to nextSqrtP:
      // delta_x = L * (1/nextSqrtP - 1/currSqrtP), rewritten as
      // L*(currSqrtP-nextSqrtP)/(nextSqrtP*currSqrtP) to avoid subtracting
      // two independently-rounded reciprocals (same class of precision loss
      // as swapUSDCForSOL below -- see comment there).
      const maxInForThisRange =
        (currL * (currSqrtP - nextSqrtP)) / (nextSqrtP * currSqrtP);

      if (remainingIn <= maxInForThisRange) {
        // Numerically stable form. The naive approach -- computing
        // finalSqrtP via 1/(1/currSqrtP + remainingIn/currL), then
        // subtracting it from currSqrtP -- subtracts two nearly-identical
        // large values whenever remainingIn is tiny relative to currL (the
        // common case), losing almost all precision. Deriving the output
        // directly avoids that: with denom = 1 + remainingIn*currSqrtP/currL,
        // finalSqrtP = currSqrtP/denom exactly, and algebraic substitution
        // gives totalUSDCOut = currSqrtP^2*remainingIn/denom with no
        // subtraction of near-equal quantities anywhere in the computation.
        const denom = 1 + (remainingIn * currSqrtP) / currL;
        const finalSqrtP = currSqrtP / denom;
        totalUSDCOut += (currSqrtP * currSqrtP * remainingIn) / denom;
        currSqrtP = finalSqrtP;
        remainingIn = 0;
      } else {
        totalUSDCOut += currL * (currSqrtP - nextSqrtP);
        remainingIn -= maxInForThisRange;
        currSqrtP = nextSqrtP;
        currL += this.tickArray.get(nextTick) || 0;
        currTick = nextTick;
        tickPointer++;
      }

      if (currL <= 0) {
        throw new Error("Pool out of liquidity in range");
      }
    }

    return {
      amountOut: totalUSDCOut,
      feePaid: fee,
      executionPrice: totalUSDCOut / netIn,
      newPoolPrice: Math.pow(currSqrtP, 2),
    };
  }
}

// ============================================================================
// 3. Bin-based Liquidity AMM (Meteora DLMM) — zero slippage within a bin
// ============================================================================

export class DLMMPool {
  constructor(
    public activeBinId: number,
    public binStepBps: number,
    public feeRate: number,
    public bins: DLMMBin[],
  ) {}

  swapUSDCForSOL(amountInUSDC: number): SwapResult {
    const fee = amountInUSDC * this.feeRate;
    let remainingIn = amountInUSDC - fee;
    let totalSOLOut = 0;
    let lastBinPrice = 0;

    const activeBins = this.bins
      .filter((b) => b.binId >= this.activeBinId)
      .sort((a, b) => a.binId - b.binId);

    for (const bin of activeBins) {
      if (remainingIn <= 0) break;

      lastBinPrice = bin.price;
      const maxUSDCInBin = bin.reserveX * bin.price;

      if (remainingIn <= maxUSDCInBin) {
        totalSOLOut += remainingIn / bin.price;
        remainingIn = 0;
      } else {
        totalSOLOut += bin.reserveX;
        remainingIn -= maxUSDCInBin;
      }
    }

    if (remainingIn > 0) {
      throw new Error("Insufficient bin depth to complete trade");
    }

    return {
      amountOut: totalSOLOut,
      feePaid: fee,
      executionPrice: (amountInUSDC - fee) / totalSOLOut,
      newPoolPrice: lastBinPrice,
    };
  }

  swapSOLForUSDC(amountInSOL: number): SwapResult {
    const fee = amountInSOL * this.feeRate;
    let remainingIn = amountInSOL - fee;
    let totalUSDCOut = 0;
    let lastBinPrice = 0;

    // Selling SOL pushes price down: walk bins at/below the active bin.
    const activeBins = this.bins
      .filter((b) => b.binId <= this.activeBinId)
      .sort((a, b) => b.binId - a.binId);

    for (const bin of activeBins) {
      if (remainingIn <= 0) break;

      lastBinPrice = bin.price;
      const maxSOLInBin = bin.reserveY / bin.price;

      if (remainingIn <= maxSOLInBin) {
        totalUSDCOut += remainingIn * bin.price;
        remainingIn = 0;
      } else {
        totalUSDCOut += bin.reserveY;
        remainingIn -= maxSOLInBin;
      }
    }

    if (remainingIn > 0) {
      throw new Error("Insufficient bin depth to complete trade");
    }

    return {
      amountOut: totalUSDCOut,
      feePaid: fee,
      executionPrice: totalUSDCOut / (amountInSOL - fee),
      newPoolPrice: lastBinPrice,
    };
  }
}

// ============================================================================
// 4. Central Limit Order Book (Phoenix / OpenBook)
// ============================================================================

export class OrderBookDEX {
  constructor(
    public askOrders: LimitOrder[], // sorted ascending by price (buy side walks these)
    public bidOrders: LimitOrder[], // sorted descending by price (sell side walks these)
    public takerFeeRate: number,
  ) {}

  swapUSDCForSOL(amountInUSDC: number): SwapResult {
    const fee = amountInUSDC * this.takerFeeRate;
    let remainingUSDC = amountInUSDC - fee;
    let totalSOLOut = 0;
    let lastFilledPrice = 0;

    for (const order of this.askOrders) {
      if (remainingUSDC <= 0) break;

      const orderCostUSDC = order.price * order.solQuantity;
      lastFilledPrice = order.price;

      if (remainingUSDC >= orderCostUSDC) {
        remainingUSDC -= orderCostUSDC;
        totalSOLOut += order.solQuantity;
      } else {
        totalSOLOut += remainingUSDC / order.price;
        remainingUSDC = 0;
      }
    }

    if (remainingUSDC > 0) {
      throw new Error("Order book depth exhausted");
    }

    return {
      amountOut: totalSOLOut,
      feePaid: fee,
      executionPrice: (amountInUSDC - fee) / totalSOLOut,
      newPoolPrice: lastFilledPrice,
    };
  }

  swapSOLForUSDC(amountInSOL: number): SwapResult {
    const fee = amountInSOL * this.takerFeeRate;
    let remainingSOL = amountInSOL - fee;
    let totalUSDCOut = 0;
    let lastFilledPrice = 0;

    for (const order of this.bidOrders) {
      if (remainingSOL <= 0) break;

      lastFilledPrice = order.price;

      if (remainingSOL >= order.solQuantity) {
        remainingSOL -= order.solQuantity;
        totalUSDCOut += order.solQuantity * order.price;
      } else {
        totalUSDCOut += remainingSOL * order.price;
        remainingSOL = 0;
      }
    }

    if (remainingSOL > 0) {
      throw new Error("Order book depth exhausted");
    }

    return {
      amountOut: totalUSDCOut,
      feePaid: fee,
      executionPrice: totalUSDCOut / (amountInSOL - fee),
      newPoolPrice: lastFilledPrice,
    };
  }
}
