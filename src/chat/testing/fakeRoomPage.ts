// What ChatService's room page script answers, read off a fake room's hash:
// whether anything is older than the page, the oldest message's index member,
// then id, message and reactions ('' for none) for each, newest first. The
// script itself runs against real redis in test/chat-history-paging.spec.ts.
export function fakeRoomPage(
  room: Record<string, string> = {},
  reactions: Record<string, string> = {},
  limit: number,
): Array<number | string> {
  const members = Object.entries(room)
    .map(([id, value]) => ({
      id,
      value,
      member: `${JSON.parse(value).timestamp}|${id}`,
    }))
    .sort((a, b) => (a.member < b.member ? 1 : -1));
  const page = members.slice(0, limit);

  return [
    members.length > limit ? 1 : 0,
    page[page.length - 1]?.member ?? "",
    ...page.flatMap(({ id, value }) => [id, value, reactions[id] ?? ""]),
  ];
}

export function isRoomPageScript(script: string) {
  return script.includes("'BYLEX', 'REV'");
}
