/**
 * The operational environment behind the hero.
 *
 * A remote high-desert strip at the hour a MALE sortie launches or recovers:
 * ridgelines stacked back into haze, a dispersed ground site on the horizon,
 * and the sky doing most of the work. It is drawn rather than photographed on
 * purpose - a vector scene is sharp on a 4K projector, costs about two
 * kilobytes, needs no licence, and can restate itself in both themes, which a
 * JPEG cannot. Every colour below is a token, so the daylight version and the
 * dusk version are the same drawing lit differently.
 *
 * If a real photograph is preferred, drop it in and set --hero-photo; the CSS
 * layers it over this and the scrim keeps the copy readable either way. See
 * the note on .hero__photo.
 *
 * Nothing here is a real place. The console says so on the mission panel, and
 * the geometry is deliberately generic.
 */

export function HeroBackdrop() {
  return (
    <div className="hero__scene" aria-hidden>
      <svg
        className="hero__scene-art"
        viewBox="0 0 1600 520"
        preserveAspectRatio="xMinYMax slice"
        role="presentation"
      >
        <defs>
          <linearGradient id="ht-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--hero-sky-hi)" />
            <stop offset="62%" stopColor="var(--hero-sky-mid)" />
            <stop offset="100%" stopColor="var(--hero-sky-lo)" />
          </linearGradient>

          {/* The sun sits just off the horizon - the light the ridges read by. */}
          <radialGradient id="ht-sun" cx="0.72" cy="0.86" r="0.42">
            <stop offset="0%" stopColor="var(--hero-sun)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>

          {/* Haze pooling in the valleys, which is what sells the depth. */}
          <linearGradient id="ht-haze" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--hero-haze)" stopOpacity="0" />
            <stop offset="100%" stopColor="var(--hero-haze)" stopOpacity="0.85" />
          </linearGradient>

          <linearGradient id="ht-ground" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--hero-ground-hi)" />
            <stop offset="100%" stopColor="var(--hero-ground-lo)" />
          </linearGradient>
        </defs>

        <rect width="1600" height="520" fill="url(#ht-sky)" />
        <rect width="1600" height="520" fill="url(#ht-sun)" />

        {/* ---- cloud banks, flattened by distance --------------------- */}
        <g fill="var(--hero-cloud)" opacity="0.55">
          <ellipse cx="300" cy="132" rx="190" ry="15" />
          <ellipse cx="420" cy="118" rx="120" ry="10" />
          <ellipse cx="1180" cy="98" rx="230" ry="13" />
          <ellipse cx="1010" cy="126" rx="140" ry="9" />
          <ellipse cx="760" cy="86" rx="150" ry="8" />
        </g>

        {/* ---- far range ---------------------------------------------- */}
        <path
          fill="var(--hero-ridge-3)"
          d="M0 336 L120 300 L210 322 L318 268 L404 306 L512 258 L628 300 L742 262
             L848 298 L964 254 L1084 296 L1198 266 L1310 302 L1424 272 L1522 306
             L1600 286 L1600 520 L0 520 Z"
        />

        {/* ---- middle range ------------------------------------------- */}
        <path
          fill="var(--hero-ridge-2)"
          d="M0 388 L96 356 L188 380 L286 330 L386 372 L486 336 L598 378 L706 340
             L812 380 L926 344 L1042 384 L1156 348 L1272 386 L1388 352 L1496 388
             L1600 360 L1600 520 L0 520 Z"
        />

        {/* Haze between the ranges. */}
        <rect x="0" y="300" width="1600" height="120" fill="url(#ht-haze)" opacity="0.5" />

        {/* ---- near range --------------------------------------------- */}
        <path
          fill="var(--hero-ridge-1)"
          d="M0 430 L140 408 L262 428 L392 396 L520 424 L648 400 L784 428 L918 402
             L1046 430 L1180 404 L1312 430 L1444 408 L1600 428 L1600 520 L0 520 Z"
        />

        {/* ---- the ground site --------------------------------------
            Kept to the left of the drawing: this scene is cropped from its
            left edge, because it sits behind the hero copy rather than
            across the whole band. */}
        <g fill="var(--hero-base)" opacity="0.92">
          {/* control tower */}
          <rect x="430" y="372" width="9" height="34" />
          <rect x="422" y="362" width="25" height="13" rx="2" />
          {/* antenna mast and guys */}
          <rect x="560" y="346" width="3" height="60" />
          <path d="M561 352 L544 406 M561 352 L578 406" stroke="var(--hero-base)" strokeWidth="1" fill="none" opacity="0.7" />
          {/* dispersed hangars */}
          <path d="M300 406 L300 390 q22 -13 44 0 l0 16 Z" />
          <path d="M358 406 L358 396 q15 -9 30 0 l0 10 Z" />
          <rect x="470" y="394" width="34" height="12" rx="1.5" />
          {/* radar dish */}
          <circle cx="628" cy="392" r="7" />
          <rect x="626" y="392" width="4" height="14" />
          {/* a second cluster, further out */}
          <rect x="742" y="396" width="26" height="10" rx="1.5" />
          <rect x="790" y="368" width="2.5" height="38" />
        </g>

        {/* ---- the strip ---------------------------------------------- */}
        <rect x="0" y="424" width="1600" height="96" fill="url(#ht-ground)" />
        <path
          d="M120 456 L900 436 L900 448 L120 468 Z"
          fill="var(--hero-strip)"
          opacity="0.55"
        />

        {/* Dune shadows, low contrast - texture, not detail. */}
        <g fill="var(--hero-ridge-1)" opacity="0.22">
          <path d="M0 470 q180 -22 360 -4 t360 -2 l0 60 L0 524 Z" />
          <path d="M840 486 q200 -18 400 -2 t360 -6 l0 46 L840 524 Z" />
        </g>
      </svg>
    </div>
  )
}
