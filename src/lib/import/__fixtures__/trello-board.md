# trello-board.json

A real Trello board export, the JSON behind *Print, export, and share → Export as JSON*, taken from a
public board on 2026-11-01 and cut down to eleven cards. Every key Trello wrote on a card, list,
label, member, checklist and action is kept; the top-level `memberships` is dropped.

Anonymised: all text, names, URLs and ids were replaced. An id keeps its first eight hex digits,
which are the time the object was created. Dates, counts and `badges` are the board's own.

Changed so that one small file exercises every path, and so not as Trello wrote them:

- two cards name members in `idMembers`, one of them two, because the public board's cards have none
- the second checklist on the first card is a copy of its first
- only the list "Old ideas" is archived
- `actions` is cut to the entries about these cards; the export it came from held 1,000

What the real file showed, against what its ticket assumed:

- `actions` holds the board's newest 1,000 actions and no more: the board counted 7,155 comments in
  `badges.comments` and 3 of them were in the file
- a card has no creation date; the first eight hex digits of `id` are its Unix time
- `dateCompleted` is null on every card, including those in a Done list and those with `dueComplete`, so no real value of it has been seen
- members carry a `username` and no e-mail
- an uploaded attachment has `isUpload: true` and a URL behind Trello's sign-in, a link has `isUpload: false`
- an archived list keeps its cards, and most of them do not have `closed` set themselves
- 142 of the 222 attachments were uploads, so most of what a board attaches stays behind
