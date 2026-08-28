/**
 * The signed-in consumer.
 *
 * Deliberately small: V1 keeps a display name and an email, nothing more
 * (docs/DATABASE.md — profiles).
 */
export type User = {
  name: string;
  email: string;
};
