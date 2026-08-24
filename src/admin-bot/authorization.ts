export function isOwner(
  actorTelegramId: number | string | undefined,
  ownerTelegramId: string,
): boolean {
  if (actorTelegramId === undefined) {
    return false;
  }

  return String(actorTelegramId) === ownerTelegramId;
}
