'use client';

import type { ActionDescription } from '@/lib/client/actions';
import { FormView } from '../views/FormView';
import { useSession } from './session';

/** A `target=new` action (wizard) rendered inside a dialog (A-4 §16). */
export function ActionDialog({ description, context, onDone }: { description: ActionDescription; context: Record<string, unknown>; onDone: (changed: boolean) => void }) {
  const user = useSession();
  const form = description.views.form;
  if (!form || form.arch.type !== 'form' || !description.action.model) {
    return <div className="text-muted">This action has no form view.</div>;
  }
  return (
    <FormView
      arch={form.arch}
      fields={description.fields}
      relatedFields={description.relatedFields}
      model={description.action.model}
      recordId={null}
      context={context}
      user={user}
      slug={description.slug}
      mode="dialog"
      onDone={onDone}
    />
  );
}
