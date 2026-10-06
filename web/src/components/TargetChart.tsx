/**
 * The hero picture: a price line that climbs from today's price to the target line and sells there.
 * Drawn once on load (respects reduced motion). Illustrative, not market data.
 */
export function TargetChart() {
  // Price path in a 560 x 200 box: entry at y=150, target at y=46.
  const path = "M8 150 L52 142 L88 158 L126 132 L160 140 L198 112 L236 124 L272 96 L306 104 L344 80 L378 90 L412 64 L446 70 L476 46";
  return (
    <figure className="target-chart" aria-label="A price climbing to a +25% target, where the order sells">
      <svg viewBox="0 0 560 200" role="img">
        <line className="grid" x1="0" y1="190" x2="560" y2="190" />
        <line className="entry" x1="0" y1="150" x2="560" y2="150" />
        <text x="0" y="172">Today</text>
        <line className="goal" x1="0" y1="46" x2="560" y2="46" />
        <text className="goal-t" x="0" y="34">
          Your target +25%
        </text>
        <path className="price draw" d={path} />
        <circle className="hit-ring" cx="476" cy="46" r="6" />
        <circle className="hit" cx="476" cy="46" r="6" />
        <g className="tag">
          <rect x="488" y="58" width="72" height="26" rx="13" />
          <text x="524" y="75" textAnchor="middle">
            Sold
          </text>
        </g>
      </svg>
    </figure>
  );
}
