# Avatar artwork

Drop files here named for the state they represent. The first extension that
loads wins, tried in this order: `webp`, `gif`, `png`, `jpg`, `svg`.

| File | Shown when |
|---|---|
| `offline.<ext>` | No session running |
| `listening.<ext>` | Session live, waiting for you to speak |
| `thinking.<ext>` | Running a tool, or composing a reply (also used while connecting) |
| `speaking.<ext>` | Talking |

Animated GIF and WebP both work and are the point of splitting the states.
Square art, at least 112×112 so it stays crisp on a retina display; it is
rendered as a circle, so keep the subject centred.

Any state without a file falls back to the animated orb, so you can add them
one at a time.
