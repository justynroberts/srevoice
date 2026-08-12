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

Square art, 256px or larger; it renders as a 56px circle, so keep the subject
centred. Animated GIF and WebP both work.

The committed set was resized to 256px and converted with:

    sips -Z 256 source.png --out tmp.png && cwebp -q 88 tmp.png -o state.webp
