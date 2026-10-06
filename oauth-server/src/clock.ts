/** Source de temps injectable : les tests avancent le temps sans attendre. */
export interface Clock {
  /** Instant courant, en millisecondes depuis l'epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
