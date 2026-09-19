import { redirect } from 'next/navigation';

/** `/` → the web client (which redirects to login when needed). */
export default function Index() {
  redirect('/odoo');
}
