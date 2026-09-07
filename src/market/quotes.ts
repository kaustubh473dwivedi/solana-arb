import "dotenv/config";

const JUPITER_QUOTE_URL =
  "https://api.jup.ag/swap/v1/quote";

export interface Quote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;

  contextSlot?: number;

  routePlan?: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
    };
    percent: number;
    bps: number | null;
  }>;
}

/*
 * Global Jupiter request pacing.
 *
 * Every quote request goes through this gate.
 *
 * Important:
 * - Requests are serialized.
 * - A 429 puts the whole client into cooldown.
 * - We do not hammer Jupiter with immediate retries.
 */

const MIN_REQUEST_INTERVAL_MS = 750;

const MAX_RATE_LIMIT_RETRIES = 1;

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10_000;

let nextAllowedRequestAt = 0;


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let requestQueue: Promise<void> = Promise.resolve();

function queueRequest<T>(
  request: () => Promise<T>,
): Promise<T> {
  const next = requestQueue.then(
    () => request(),
    () => request(),
  );

  requestQueue = next.then(
    () => undefined,
    () => undefined,
  );

  return next;
}
async function waitForRequestSlot(): Promise<void> {
  const now = Date.now();

  if (now < nextAllowedRequestAt) {
    await sleep(nextAllowedRequestAt - now);
  }

  nextAllowedRequestAt =
    Date.now() + MIN_REQUEST_INTERVAL_MS;
}

function getRetryAfterMs(
  response: Response,
): number {
  const retryAfter =
    response.headers.get("retry-after");

  if (retryAfter) {
    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds)) {
      return Math.max(
        seconds * 1_000,
        DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      );
    }
  }

  return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

async function fetchQuote(
  url: URL,
  apiKey: string,
): Promise<Response> {
  return queueRequest(async () => {
    for (
      let attempt = 0;
      attempt <= MAX_RATE_LIMIT_RETRIES;
      attempt++
    ) {
      await waitForRequestSlot();

      const response = await fetch(url, {
        headers: {
          "x-api-key": apiKey,
        },
      });

      if (response.status !== 429) {
        return response;
      }

      const cooldown =
        getRetryAfterMs(response);

      console.warn(
        `Jupiter rate limited request (429). ` +
          `Cooldown ${cooldown}ms. ` +
          `Attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES + 1}.`,
      );

      /*
       * Move the global request window forward.
       *
       * No other queued quote request should hit Jupiter
       * during this cooldown.
       */
      nextAllowedRequestAt =
        Date.now() + cooldown;

      if (attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(cooldown);
      }
    }

    throw new Error(
      "Jupiter quote rate limited after retry",
    );
  });
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  dexes?: string[],
): Promise<Quote> {
  const apiKey =
    process.env.JUPITER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "JUPITER_API_KEY is not set in .env",
    );
  }

  const url = new URL(
    JUPITER_QUOTE_URL,
  );

  url.searchParams.set(
    "inputMint",
    inputMint,
  );

  url.searchParams.set(
    "outputMint",
    outputMint,
  );

  url.searchParams.set(
    "amount",
    amount.toString(),
  );

  if (dexes && dexes.length > 0) {
    url.searchParams.set(
      "dexes",
      dexes.join(","),
    );
  }

  const response = await fetchQuote(
    url,
    apiKey,
  );

  if (!response.ok) {
    throw new Error(
      `Jupiter quote failed: ${response.status} ${response.statusText}`,
    );
  }

  const data =
    (await response.json()) as Quote & {
      error?: string;
    };

  if (data.error) {
    throw new Error(data.error);
  }

  return data;
}
