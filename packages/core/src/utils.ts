import { ulid } from "ulid";
export function generateId(): string {
  return ulid();
}
export function now(): number {
  return Date.now();
}
