import { useState, useEffect } from 'react';
import { session } from '../lib/session';

/**
 * Hook to access session state reactively
 */
export function useSession() {
  const [isLoggedIn, setIsLoggedIn] = useState(session.isLoggedIn);

  useEffect(() => {
    return session.subscribe(() => {
      setIsLoggedIn(session.isLoggedIn);
    });
  }, []);

  return {
    isLoggedIn,
    login: session.login.bind(session),
    logout: session.logout.bind(session),
  };
}
