import { getDatabase } from "@easy-agent/core/database";
import { ulid } from "ulid";

export interface StandingIntent {
  id: string;
  keywords: string;
  text: string;
  scope: "conversation" | "channel" | "anywhere";
  maxFires?: number;
  fireCount: number;
  expiresAt?: number;
  createdAt: number;
}

export class StandingIntentManager {
  private intents: StandingIntent[] = [];

  create(
    input: Omit<StandingIntent, "id" | "fireCount" | "createAt">,
  ): StandingIntent {
    const intent: StandingIntent = {
      ...input,
      id: ulid(),
      fireCount: 0,
      createdAt: Date.now(),
    };
    this.intents.push(intent);
    return intent;
  }

  check(message: string): StandingIntent[] {
    const triggered: StandingIntent[] = [];
    const lower = message.toLowerCase();
    const now = Date.now();

    for (const intent of this.intents) {
      if (intent.expiresAt && now > intent.expiresAt) continue;

      if (intent.maxFires && intent.fireCount >= intent.maxFires) continue;

      if (intent.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
        intent.fireCount++;
        triggered.push(intent);
      }
    }

    return triggered;
  }

  list(): StandingIntent[] {
    return this.intents.filter(
      (i) =>
        (!i.expiresAt || Date.now() < i.expiresAt) &&
        (!i.maxFires || i.fireCount < i.maxFires),
    );
  }

  cancel(id: string): void {
    this.intents = this.intents.filter((i) => i.id !== id);
  }
}
