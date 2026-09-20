'use client';

/** Placeholder shapes shown while a view's first data arrives (perceived speed). */
export function ListSkeleton({ columns = 6, rows = 8 }: { columns?: number; rows?: number }) {
  return (
    <div className="o_list_skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="o_skeleton_row">
          <span className="o_skeleton" style={{ width: 14 }} />
          {Array.from({ length: columns }, (_, column) => (
            <span key={column} className="o_skeleton" style={{ flex: column === 0 ? '0 0 22%' : '1 1 0', opacity: 1 - row * 0.08 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function FormSkeleton() {
  return (
    <div className="o_skeleton_form" aria-hidden="true">
      <span className="o_skeleton" style={{ gridColumn: '1 / -1', width: '40%', height: 26 }} />
      {Array.from({ length: 8 }, (_, index) => (
        <span key={index} className="o_skeleton" style={{ width: `${55 + ((index * 17) % 40)}%` }} />
      ))}
      <span className="o_skeleton" style={{ gridColumn: '1 / -1', height: 120 }} />
    </div>
  );
}
