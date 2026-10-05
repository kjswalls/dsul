import { LoginPage } from './login-page';
import { signInProviders } from '@/lib/sign-in-providers';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Asked here, on the server, so the Apple button is in the first paint or
  // not at all: never a button that appears under the pointer a beat late.
  const { apple } = await signInProviders();
  return <LoginPage apple={apple} />;
}
