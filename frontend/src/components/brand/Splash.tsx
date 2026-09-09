/**
 * The first paint.
 *
 * The cinematic routes carry a renderer, a scene and an engine assembly, and on
 * a cold load over a slow link that is a second or two of nothing. A blank
 * gradient there reads as a broken page - the browser tab says AEROTWIN and the
 * viewport says nothing at all.
 *
 * So the first paint is the mark, immediately. This component pulls in no 3D,
 * no charts and no store: it is in the entry chunk and shows the moment the
 * document does, while the heavy chunks stream in behind it.
 */

import { Mark } from './Wordmark'

export function Splash({ label = 'LOADING' }: { label?: string }) {
  return (
    <div className="splash">
      <div className="splash__inner">
        <Mark size={46} className="splash__mark" />
        <div className="splash__name">AEROTWIN</div>
        <div className="splash__sub">PROPULSION INTELLIGENCE</div>
        <div className="splash__bar">
          <span className="splash__bar-fill" />
        </div>
        <div className="splash__label">{label}</div>
      </div>
    </div>
  )
}
