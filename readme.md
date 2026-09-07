 Since package.json has no "dev"/"start"/"build" scripts defined yet, you're invoking tsx/tsc/node directly for now — want 
  me to add proper npm scripts (e.g. npm run scan, npm run collect, npm run build) so you don't have to remember these      
  paths?






    #: 1                                                                                                                      
  Cost: Base fee                                                                                                            
  What it is: Fixed network fee per signature                                                                               
  Paid to: Leader validator (partly burned)                                                                                 
  When charged: Whenever the transaction is processed, win or lose the swap logic                                           
  Typical amount: 5,000 lamports/signature (~$0.00075)                                                                      
  Refundable?: No                                                                                                           
  ────────────────────────────────────────                                                                                  
  #: 2                                                                                                                      
  Cost: Priority fee                                                                                                        
  What it is: Bid to jump the queue: price × compute unit limit                                                             
  Paid to: Leader validator                                                                                                 
  When charged: Same as base fee — processed = charged, regardless of instruction success                                   
  Typical amount: Variable — e.g. 495 lamports in our decoded example, much higher when racing other bots
  Refundable?: No
  ────────────────────────────────────────
  #: 3                                                                                                                      
  Cost: Jito tip
  What it is: Payment for guaranteed atomic, ordered "bundle" inclusion                                                     
  Paid to: Jito-running validator                                                                                           
  When charged: Only if the bundle actually lands                                                                           
  Typical amount: Variable, bidder's choice (e.g. ~0.00001 SOL+)
  Refundable?: No (but nothing charged if it doesn't land)
  ────────────────────────────────────────
  #: 4                                                                                                                      
  Cost: DEX swap fee
  What it is: Cut taken by the liquidity pool per swap                                                                      
  Paid to: Liquidity providers of that pool                                                                                 
  When charged: Only if the swap instruction actually completes                                                             
  Typical amount: ~0.01%–1% of trade size, per leg (paid twice on a round trip)
  Refundable?: No
  ────────────────────────────────────────
  #: 5                                                                                                                      
  Cost: Price impact
  What it is: Cost of your own trade size moving the pool's price                                                           
  Paid to: Nobody — it's a shortfall vs. spot price                                                                         
  When charged: Only if the swap actually completes                                                                         
  Typical amount: Scales with trade size ÷ pool depth (e.g. 1.96% in our worked example)
  Refundable?: No
  ────────────────────────────────────────
  #: 6                                                                                                                      
  Cost: Slippage
  What it is: Cost of the market moving between quote time and execution time                                               
  Paid to: Nobody — same, a shortfall vs. quoted price                                                                      
  When charged: Only if the swap actually completes, bounded by slippageBps                                                 
  Typical amount: Unpredictable, grows with quote staleness
  Refundable?: No
  ────────────────────────────────────────
  #: 7                                                                                                                      
  Cost: Rent
  What it is: One-time deposit to keep a new account's data alive on-chain                                                  
  Paid to: Locked into the account itself                                                                                   
  When charged: Only when a new account is created (e.g. first USDC token account)                                          
  Typical amount: ~0.00186 SOL for a 165-byte token account
  Refundable?: Yes — reclaimed if you close the account

  Grouped by when you actually pay                                                                                          
                                                                                                                            
  ALWAYS paid, if the transaction lands at all (win or lose the swap):                                                      
    → base fee + priority fee                                                                                               
                                                                                                                            
  ONLY paid if the swap instruction actually succeeds:                                                                      
    → DEX swap fee, price impact, slippage                                                                                  
                                                                                                                            
  ONLY paid on a new account (one-time, refundable):                                                                        
    → rent                                                                                                                  
                                                                                                                            
  ONLY paid if you win a Jito auction:                                                                                      
    → Jito tip  




    Higher Fee Earnings: Because your active capital density is much higher than a v2 pool, you earn a significantly higher share of trading fees with less upfront capital.






    Comparison of Execution RulesDEX TypeSlippage MechanismKey Variable for MathMath ComplexityConstant ProductContinuous curveReserves $(x, y)$Simple ($x \cdot y = k$)CLMMContinuous curve inside rangeActive Liquidity ($L$) & $\sqrt{P}$Medium (Tick crossing handling)DLMMZero inside bin, steps across binsDiscrete Bins & Bin IDLow within bin, array traversal across binsOrder BookStep-wise limit order matchingasks[] / bids[] arrayIterative array matching




    Here are the 4 DEX protocols covered in the TypeScript example:Raydium / Orca v1 — Constant Product AMMMechanism: Traditional $x \cdot y = k$ pool with continuous, automated price curves.Orca Whirlpool / Raydium CLMM — Concentrated Liquidity AMMMechanism: Range-bound active liquidity ($L$) tracking $\sqrt{P}$ within specific tick boundaries.Meteora DLMM — Dynamic Liquidity Book / Bin-Based AMMMechanism: Discrete price bins with zero slippage inside individual active bins.Phoenix / OpenBook — Central Limit Order Book (CLOB)Mechanism: Direct limit order matching against an on-chain sorted array of asks and bids.


    Good code overall — the four classes correctly implement the math we've been walking through (constant product, CLMM      
  tick-crossing with the same √price mechanics, DLMM bin-walking, order-book matching). A few small things worth fixing     
  before it goes in (I'll list them), but the bigger question is architectural, not code-quality: this engine computes swap 
  math from pool state you hand it manually — it doesn't fetch real pool data itself. That's exactly complementary to       
  expenses.ts (which only covers the external costs — base fee, priority fee, rent — deliberately excluding DEX fee/price   
  impact since those are "baked into Jupiter's quote"). Together, this code + expenses.ts would be a full manual cost model,
  replacing the need for Jupiter's quote API entirely — but only for whichever DEXes you actually build a real on-chain     
  reader for. Right now your bot has zero of those readers; we only proved the concept once, live, decoding that real       
  Whirlpool account together.  





   run all 4 architectures against every remaining DEX label


  - npx tsc --noEmit — clean                                                                                                
  - Bot ran a full scan cycle: all 7 cross-checked DEXes agreed with Jupiter within ~1% (Raydium/Orca V2/Whirlpool/Raydium  
  CLMM within 0.01%, Meteora DLMM ~0.007%, Phoenix ~1% due to its real wide spread, as expected)                            
  - OpenBook V2 failed cleanly (Jupiter 400, no route) and was skipped without crashing                                     
  - Round-trip P&L math and JSONL logging both still writing correctly (logs/arbitrage-opportunities.jsonl got a fresh entry
  with both buyOnChainOutAmount/sellOnChainOutAmount populated)   

  Jupiter's quote — a full JSON object describing a route, potentially multiple hops:                                       
  {                                                                                                                         
    "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",                                                            
    "outputMint": "So11111111111111111111111111111111111111112",                                                            
    "inAmount": "10000000",                                                                                                 
    "outAmount": "95161549",                                                                                                
    "priceImpactPct": "0.0008674676",                                                                                       
    "contextSlot": 445035028,                                                                                               
    "routePlan": [                                                                                                          
      {                                                                                                                     
        "swapInfo": {                                                                                                       
          "ammKey": "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",                                                         
          "label": "Raydium",                                                                                               
          "inputMint": "EPjFWdd5...",                                                                                       
          "outputMint": "So11111...",                                                                                       
          "inAmount": "10000000",                                                                                           
          "outAmount": "95161549"                                                                                           
        },                                                                                                                  
        "percent": 100,                                                                                                     
        "bps": null                                                                                                         
      }                                                                                                                     
    ]                                                                                                                       
  }                                                                                                                         
  That's the real Quote shape from market/quotes.ts — rich, describes the route (which pool(s), what split), not just a     
  number.                                                                                                                   
                                                                                                                            
  Our on-chain computed quote — much smaller, since it's pure arithmetic on pool state, not a routing description:          
  {                                                                                                                         
    "amountOut": 0.095161548,                                                                                               
    "feePaid": 0.025,                                                                                                       
    "executionPrice": 105.08,                                                                                               
    "newPoolPrice": 105.09                                                                                                  
  } 





  Jupiter's answer — field by field, plain English                                                                          
                                                                                                                            
  ┌────────────────┬─────────────┬───────────────────────────────────────────────────────────────────┐                      
  │     Field      │ Real value  │                   What it means in plain words                    │
  ├────────────────┼─────────────┼───────────────────────────────────────────────────────────────────┤                      
  │ inputMint      │ EPjFWdd5... │ The USDC address — "this is USDC"                                 │
  ├────────────────┼─────────────┼───────────────────────────────────────────────────────────────────┤
  │ outputMint     │ So11111...  │ The SOL address — "this is SOL"                                   │                      
  ├────────────────┼─────────────┼───────────────────────────────────────────────────────────────────┤
  │ inAmount       │ 10000000    │ You're putting in 10,000,000 micro-USDC = 10 USDC                 │                      
  ├────────────────┼─────────────┼───────────────────────────────────────────────────────────────────┤                      
  │ outAmount      │ 95161549    │ You'll get back 95,161,549 lamports = 0.095161549 SOL             │                      
  ├────────────────┼─────────────┼──────────────────────────────────────────────────────────┤────────┤                      
  │ priceImpactPct │ 0.00087%    │ Your trade is small enough that it barely moved the price         │                      
  ├────────────────┼─────────────┼───────────────────────────────────────────────────────────────────┤                      
  │ contextSlot    │ 445035028   │ The exact moment (block) this answer was computed at              │                      
  ├────────────────┼─────────────┼───────────────────────────────────────────────────────────────────┤                      
  │ routePlan      │ one entry   │ "I used exactly one pool: the Raydium pool at address 58oQChx..." │                      
  └────────────────┴─────────────┴──────────────────────────────────────────────────────────────────┘                       
                                                                                                                            
  In one sentence: Jupiter is telling you "put in 10 USDC, and through this one Raydium pool, you'll get 0.0952 SOL back."* 
  That's it. Everything else in that JSON is just supporting detail (which pool, how much the price moved, when).           
                                                                                                                            
  Our own computed answer — field by field, plain English
                                                                                                                            
  ┌────────────────┬─────────────┬───────────────────────────────────────────────────────────────────────────────────────┐
  │     Field      │ Real value  │                             What it means in plain words                              │
  ├────────────────┼─────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ amountOut      │ 0.095161548 │ Same thing as Jupiter's outAmount — how much SOL you get back — just already          │
  │                │             │ converted to a normal decimal number instead of raw lamports
  ├────────────────┼─────────────┼───────────────────────────────────────────────────────────────────────────────────────┤  
  │ feePaid        │ 0.025       │ How much of your 10 USDC the pool kept as its trading fee                             │
  ├────────────────┼─────────────┼───────────────────────────────────────────────────────────────────────────────────────┤  
  │ executionPrice │ 105.08      │ The actual price you paid, on average, for this trade: ~105.08 USDC per SOL           │  
  ├────────────────┼────────────┴┼──────────────────────────────────────────────────────────────────────────────────────┘┤  
  │ newPoolPrice   │ 105.09      │ What the pool's price becomes after your trade (barely moved, since your trade is     │  
  │                │             │ tiny)                                                                                 │  
  └────────────────┴─────────────┴───────────────────────────────────────────────────────────────────────────────────────┘  
                                






                                Raydium, Orca V2    │ Hardcoded, pre-verified address (we confirmed it live once, it's baked into  │ No            │
  │                     │ the code)                                                                    │               │    
  ├─────────────────────┼──────────────────────────────────────────────────────────────────────────────┼───────────────┤
  │ Phoenix             │ Fetches Phoenix's own published market list file directly from GitHub        │ No            │
  ├─────────────────────┼──────────────────────────────────────────────────────────────────────────────┼───────────────┤
  │ OpenBook V2         │ Hardcoded, pre-verified address                                              │ No            │    
  ├─────────────────────┼─────────────────────────────────────────────────────────────────────────────┼───────────────┤│
  │ Whirlpool, Raydium  │ Asks Jupiter for a quote filtered to that one DEX, then reads the real pool  │ Yes, for      │    
  │ CLMM, Meteora DLMM  │ address out of the route it returns — we throw away Jupiter's price/amount   │ discovery     │    
  │                     │ entirely, we only keep the ammKey (address)                                  │ only          │    
  └─────────────────────┴────────────────────────