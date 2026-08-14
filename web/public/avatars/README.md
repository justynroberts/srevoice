# Avatar artwork

One image per conversational state, loaded by convention. The first name and
extension that loads wins; extensions are tried in order `webp`, `gif`, `png`,
`jpg`, `svg`.

| File | Shown when | Falls back to |
|---|---|---|
| `offline.<ext>` | No session running | — |
| `connecting.<ext>` | Waking up, before the socket is live | `listening`, `thinking` |
| `listening.<ext>` | Session live, waiting for you to speak | — |
| `thinking.<ext>` | Running a tool or composing a reply | — |
| `speaking.<ext>` | Talking | — |

Any state with no file falls back to the animated orb, so a partial set is fine.

## Light theme

`light/` holds art for the light theme, using the same filenames. In light mode
each state tries `light/` first and falls back to the default set, so a partial
light set is not a broken image — the states you have art for use it and the
rest borrow the dark art.

Portraits are drawn against a background rather than cut out, so a near-white
matte in a dark console reads as a rendering fault rather than as a portrait.
That is the whole reason for the split; if your art is a transparent PNG you do
not need `light/` at all.

There is no `dark/` — the top level *is* the dark set, which keeps existing
installs working untouched.

## Making the files

Square art. It renders as a 132px circle, so keep the subject centred and
supply at least 264px; the committed sets are 384px, which covers 2× displays.

    cwebp -q 82 -resize 384 384 source.png -o light/listening.webp

Animated GIF and WebP both work.
