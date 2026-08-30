import type { UserMessage } from './canvas-types';

export class UserMessageQueue {
  private messages: UserMessage[] = [];
  private nextId = 1;

  constructor(private readonly limit = 50) {}

  add(text: string, source: UserMessage['source']): UserMessage {
    const normalized = text.trim();
    if (!normalized) throw new Error('Message text cannot be empty.');
    const message: UserMessage = {
      id: this.nextId++,
      text: normalized,
      source,
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    if (this.messages.length > this.limit) this.messages.splice(0, this.messages.length - this.limit);
    return message;
  }

  poll(afterId = 0): { messages: UserMessage[]; latestId: number } {
    const cursor = Number.isFinite(afterId) ? Math.max(0, Math.floor(afterId)) : 0;
    return {
      messages: this.messages.filter((message) => message.id > cursor),
      latestId: this.messages.at(-1)?.id ?? 0,
    };
  }

  all(): UserMessage[] {
    return [...this.messages];
  }
}

