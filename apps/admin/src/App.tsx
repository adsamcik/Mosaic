import { useEffect, useState } from 'react';
import { session } from './lib/session';
import { LoginForm } from './components/Auth/LoginForm';
import { AppShell } from './components/App/AppShell';
import './styles/globals.css';

/**
 * Root Application Component
 * Manages authentication state and renders appropriate view
 */
export function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(session.isLoggedIn);

  useEffect(() => {
    // Subscribe to session state changes
    return session.subscribe(() => {
      setIsLoggedIn(session.isLoggedIn);
    });
  }, []);

  if (!isLoggedIn) {
    return <LoginForm />;
  }

  return <AppShell />;
}
