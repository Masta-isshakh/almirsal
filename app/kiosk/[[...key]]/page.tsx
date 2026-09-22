import { getPublicEnvironment } from '@/lib/server/public';
import { kioskKey, kioskSettings } from '@/packages/apps/hr/attendance';
import { Kiosk } from '@/components/kiosk/Kiosk';

export const dynamic = 'force-dynamic';

/** `/kiosk/<key>` — the public attendance kiosk (D-8); the key comes from Settings › Attendances. */
export default async function KioskPage({ params }: { params: Promise<{ key?: string[] }> }) {
  const { key = [] } = await params;
  const env = await getPublicEnvironment();
  const expected = await kioskKey(env);
  if (key[0] !== expected) {
    return (
      <div className="o_kiosk"><main className="o_kiosk_main">
        <i className="fa fa-lock o_kiosk_icon text-muted" aria-hidden="true" />
        <h1>Attendance Kiosk</h1>
        <p className="text-muted">This kiosk link is not valid. Open Settings › Attendances to copy the kiosk URL.</p>
      </main></div>
    );
  }
  return <Kiosk kioskKey={expected} settings={await kioskSettings(env)} />;
}
