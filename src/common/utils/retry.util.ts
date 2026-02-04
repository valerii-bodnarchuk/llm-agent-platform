interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  exponentialBackoff?: boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 1000,
    exponentialBackoff = true,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const statusCode = (error as { statusCode?: number }).statusCode;

      // Non-retryable errors (client errors except rate limit)
      const isNonRetryable =
        statusCode === 400 || // Bad request
        statusCode === 401 || // Unauthorized
        statusCode === 403 || // Forbidden
        statusCode === 404 || // Not found
        statusCode === 422 || // Validation error
        (statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 429);

      if (isNonRetryable || attempt === maxAttempts) {
        throw error;
      }

      // All other errors are retryable (5xx, network, timeouts, etc)
      const delay = exponentialBackoff
        ? delayMs * Math.pow(2, attempt - 1)
        : delayMs;

      console.log(
        `Retry attempt ${attempt}/${maxAttempts} after ${delay}ms. Error: ${lastError.message}`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}