'use client';

/** Placeholder until the remaining generic views land (J-1 phase 3). */
export function UnsupportedView({ type }: { type: string }) {
  return (
    <div className="p-5 text-center text-muted">
      <i className="fa fa-wrench fa-2x mb-3 d-block" aria-hidden="true" />
      The <code>{type}</code> view is not rendered yet.
    </div>
  );
}
