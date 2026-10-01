import { redirect } from 'next/navigation';

/**
 * /extensions — the store's old address. The store is now the body of
 * Settings → Extensions, so this only forwards there, keeping the link anyone
 * saved working.
 */
export default function ExtensionsPage() {
  redirect('/settings/extensions');
}
