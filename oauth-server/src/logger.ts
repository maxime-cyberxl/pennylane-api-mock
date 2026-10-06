// Journal volontairement minimal : n'y écrire que des informations non sensibles
// (jamais de client secret, code, access token ou refresh token, ni de corps de requête).

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => {
    console.log(`${new Date().toISOString()} ${message}`);
  },
  error: (message) => {
    console.error(`${new Date().toISOString()} ${message}`);
  },
};

export const silentLogger: Logger = { info: () => undefined, error: () => undefined };
