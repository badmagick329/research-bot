import { QueryClient } from "@tanstack/react-query";

/**
 * Sets conservative query defaults so polling can be added consistently without noisy retries.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
