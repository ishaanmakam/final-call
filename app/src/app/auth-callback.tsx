import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Body, Button, ErrorText, Loading, Screen } from '@/components/ui';
import { completeMagicLink } from '@/lib/auth';

/** Target of the magic link: showup://auth-callback?code=... (PKCE). */
export default function AuthCallback() {
  const params = useLocalSearchParams<{ code?: string; error_description?: string }>();
  const [error, setError] = useState<unknown>(
    params.error_description ? new Error(params.error_description) : null,
  );

  useEffect(() => {
    if (!params.code) {
      if (!params.error_description) setError(new Error('This sign-in link is missing its code. Request a new one.'));
      return;
    }
    completeMagicLink(params.code)
      .then(() => router.replace('/groups'))
      .catch(setError);
  }, [params.code, params.error_description]);

  if (!error) return <Loading />;
  return (
    <Screen>
      <Body>We couldn't finish signing you in.</Body>
      <ErrorText error={error} />
      <Button title="Back to sign in" onPress={() => router.replace('/sign-in')} />
    </Screen>
  );
}
