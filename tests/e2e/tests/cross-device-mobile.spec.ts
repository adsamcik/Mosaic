/**
 * Cross-device login parity (v1.0.x s43).
 *
 * Locks the fix from fix-sweep43: a user whose account is registered in
 * the chromium project's `global-setup` (the pool user pool) MUST be
 * able to log in unchanged from the mobile-chrome project. Prior to
 * fix-sweep43, mobile-chrome derived different keys due to a KDF
 * persistence bug, which produced an "Invalid username or password"
 * failure on login. With the fix, key derivation is viewport-
 * independent and the same pool user logs in cleanly on both viewports.
 *
 * Coverage strategy:
 * - Pool users are pre-registered via chromium in `global-setup.ts`.
 * - This spec uses the existing `poolUser` fixture, which logs the
 *   pre-registered user in using the project's own browser context.
 * - The test is intentionally minimal: it only asserts that the app
 *   shell renders after login on every project the spec runs in.
 * - Configured projects today are `chromium` and `mobile-chrome`, so
 *   running this spec on both proves cross-device login parity.
 *
 * If a future regression reintroduces viewport-dependent key
 * derivation, this spec fails on the `mobile-chrome` project while
 * still passing on `chromium`, making the regression unambiguous.
 */

import { test, expect } from '../fixtures';

test.describe('cross-device login parity @auth @p0', () => {
  test('pool user registered on chromium logs in on every project', async ({ poolUser }, testInfo) => {
    const { page, username } = poolUser;

    // App shell visibility is the canonical "login + crypto init complete"
    // signal, identical to the assertion the poolUser fixture itself
    // already performs. We re-assert here so the failure surface is on
    // this spec rather than the shared fixture in case of regression.
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });

    // Sanity log to make CI diagnosis trivial when the spec fails on
    // exactly one project.
    // eslint-disable-next-line no-console
    console.log(
      `[cross-device-mobile] project=${testInfo.project.name} user=${username} login OK`,
    );
  });
});
