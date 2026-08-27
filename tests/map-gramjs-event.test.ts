import { describe, expect, it } from 'vitest';
import { Api } from 'telegram';
import bigInt from 'big-integer';

import { mapGramJsEvent } from '../src/user-client/gramjs-client.service.js';

function createChannelEntity(
  id: string,
  options: { megagroup?: boolean; broadcast?: boolean } = {},
): Api.Channel {
  return new Api.Channel({
    id: bigInt(id),
    accessHash: bigInt(`9${id}`),
    title: 'regression-channel',
    photo: new Api.ChatPhotoEmpty(),
    date: 0,
    broadcast: options.broadcast ?? true,
    megagroup: options.megagroup ?? false,
  });
}

function createPost(channelId: string, messageId = 1, text = 'hello'): Api.Message {
  const message = new Api.Message({
    out: false,
    mentioned: false,
    mediaUnread: false,
    silent: false,
    post: true,
    id: messageId,
    peerId: new Api.PeerChannel({ channelId: bigInt(channelId) }),
    message: text,
    date: 0,
  });
  // getSender requires a connected client in production; the service defends the
  // call with .catch(() => undefined), but we provide a safe stub so the unit
  // test never throws synchronously when the harness has no live client.
  (message as unknown as { getSender: () => Promise<unknown> }).getSender = () =>
    Promise.resolve(undefined);
  return message;
}

describe('mapGramJsEvent sameChannel canonical matching', () => {
  it('classifies a broadcast post when peerId is the negative canonical form of 1611324665', async () => {
    const entity = createChannelEntity('1611324665');
    // Real Telegram Native updates can deliver the channel id in a negative
    // canonical form (e.g. -1611324665) which differs from the resolved entity
    // id (1611324665). BigInteger.equals() returns false here, the previous bug.
    const message = createPost('-1611324665');

    const mapped = await mapGramJsEvent(
      { message } as Parameters<typeof mapGramJsEvent>[0],
      entity,
    );

    expect(mapped.chatKind).toBe('channel_post');
    expect(mapped.telegramChannelId).toBe('1611324665');
    expect(mapped.sourceMessageId).toBe(1);
  });

  it('still classifies the positive canonical form of 3980589729', async () => {
    const entity = createChannelEntity('3980589729');
    const message = createPost('3980589729');

    const mapped = await mapGramJsEvent(
      { message } as Parameters<typeof mapGramJsEvent>[0],
      entity,
    );

    expect(mapped.chatKind).toBe('channel_post');
    expect(mapped.telegramChannelId).toBe('3980589729');
  });

  it('does not classify a post whose canonical id differs from the subscribed entity', async () => {
    const entity = createChannelEntity('1611324665');
    const message = createPost('-9999999999');

    const mapped = await mapGramJsEvent(
      { message } as Parameters<typeof mapGramJsEvent>[0],
      entity,
    );

    expect(mapped.chatKind).toBe('unknown');
    expect(mapped.telegramChannelId).toBeUndefined();
  });

  it('classifies a broadcast post whose negative and positive ids wrap sign consistently', async () => {
    // Generic negative-form broadcast post (mirrors the 1611324665 failure mode
    // for any channel id GramJS emits as negative).
    const entity = createChannelEntity('2000000001');
    const message = createPost('-2000000001');

    const mapped = await mapGramJsEvent(
      { message } as Parameters<typeof mapGramJsEvent>[0],
      entity,
    );

    expect(mapped.chatKind).toBe('channel_post');
    expect(mapped.telegramChannelId).toBe('2000000001');
  });
});
