"""
Общее для задач, которые ходят по чатам: разбор участников (parse-chat.py) и
обогащение (enrich-*.py). Ссылка -> сущность Telethon, вступление по
приглашению, замок на файл.
"""
import contextlib
import re

from tglib import say


def chat_ref(raw):
    """
    Ссылка на чат в вид, который понимает Telethon.

    t.me/joinchat/<hash> и t.me/+<hash> — приватные приглашения: по ним
    получить участников можно, только уже будучи внутри, поэтому такие
    возвращаем отдельно (invite), чтобы решить, входить или ругаться.
    """
    s = str(raw or "").strip()
    if not s:
        raise SystemExit("не указан чат: --chat <ссылка | @имя | id>")
    s = re.sub(r"^(https?://)?(www\.)?(t\.me|telegram\.me|telegram\.dog)/", "", s, flags=re.I)
    m = re.match(r"^(?:joinchat/|\+)(.+)$", s)
    if m:
        return None, m.group(1).strip("/")
    s = s.split("?")[0].strip("/")
    # t.me/c/2234656371/12 — приватный канал по внутреннему id. Telethon
    # понимает его как -100<id>; развернуть сможет только аккаунт-участник
    m = re.match(r"^c/(\d+)", s)
    if m:
        return int("-100" + m.group(1)), None
    if re.fullmatch(r"-?\d+", s):
        return int(s), None
    return s.lstrip("@"), None


@contextlib.contextmanager
def locked(path):
    """
    Прочитать-дополнить-записать файл под замком. Разбор идёт в несколько
    аккаунтов сразу: без замка двое читают один и тот же members.csv, а
    записывает каждый свой вариант — и люди, добавленные первым, пропадают.
    """
    try:
        import fcntl
    except ImportError:          # Windows: там разбор идёт одним аккаунтом
        yield
        return
    with open(str(path) + ".lock", "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


async def resolve_chat(client, ref, invite, join):
    """Сущность чата: по ссылке, по @имени или по приглашению."""
    from telethon import functions
    from telethon.tl.types import ChatInviteAlready, ChatInvitePeek

    if invite:
        res = await client(functions.messages.CheckChatInviteRequest(invite))
        if isinstance(res, (ChatInviteAlready, ChatInvitePeek)):
            return res.chat
        if not join:
            raise SystemExit(
                "это приватное приглашение, а аккаунт в чате не состоит.\n"
                "Участников закрытого чата видно только изнутри — вступи сам "
                "или добавь --join (в панели — галочка «вступить, если нужно»).")
        say("аккаунта в чате нет — вступаю по приглашению")
        upd = await client(functions.messages.ImportChatInviteRequest(invite))
        return upd.chats[0]

    try:
        return await client.get_entity(ref)
    except ValueError:
        raise SystemExit(f"не нашёл такой чат: {ref}. Проверь ссылку — "
                         "у публичного чата она вида t.me/имя")
