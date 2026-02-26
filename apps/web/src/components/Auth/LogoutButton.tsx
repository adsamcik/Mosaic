import { session } from '../../lib/session';

/**
 * Logout Button Component
 */
export function LogoutButton() {
  const handleLogout = () => {
    void session.logout();
  };

  return (
    <button onClick={handleLogout} className="logout-button">
      Lock
    </button>
  );
}
