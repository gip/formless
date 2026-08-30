import { describe, expect, it } from 'vitest';
import { UserMessageQueue } from '../lib/message-queue';

describe('user message queue', () => {
  it('uses a stable idempotent cursor', () => {
    const queue = new UserMessageQueue();
    queue.add('first', 'typed');
    queue.add('second', 'speech');
    expect(queue.poll(0).messages.map((message) => message.id)).toEqual([1, 2]);
    expect(queue.poll(1).messages.map((message) => message.text)).toEqual(['second']);
    expect(queue.poll(1).latestId).toBe(2);
  });

  it('caps retained transcripts and rejects empty text', () => {
    const queue = new UserMessageQueue(2);
    queue.add('one', 'typed');
    queue.add('two', 'typed');
    queue.add('three', 'speech');
    expect(queue.all().map((message) => message.text)).toEqual(['two', 'three']);
    expect(() => queue.add('   ', 'typed')).toThrow(/empty/);
  });
});

