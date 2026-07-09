export function createKickAuthService(config) {
  return {
    config,
    sessionKey: config.sessionStorageKey,
    startLogin() {
      throw new Error("Kick login flow is not migrated yet.");
    },
    logout() {
      localStorage.removeItem(config.sessionStorageKey);
    },
  };
}
