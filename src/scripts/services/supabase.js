export function createSupabaseService(config) {
  return {
    config,
    headers(extra = {}) {
      return {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        ...extra,
      };
    },
  };
}
