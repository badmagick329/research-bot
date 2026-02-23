type WebEnv = {
  apiBaseUrl: string;
};

/**
 * Reads web runtime config in one place so API transport behavior is easy to reason about across environments.
 */
export function getWebEnv(): WebEnv {
  const configured = import.meta.env.VITE_API_BASE_URL;
  const apiBaseUrl =
    typeof configured === "string" && configured.trim().length > 0
      ? configured.trim().replace(/\/$/, "")
      : "";

  return {
    apiBaseUrl,
  };
}
