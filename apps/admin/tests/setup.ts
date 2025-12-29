/**
 * Vitest setup file for React 19 testing with Happy-DOM
 *
 * This file runs before each test file and configures the global environment
 * for React's act() function to work correctly.
 */

// Tell React we're in a test environment where act() is expected
// This is required for React 19 to use act() without warnings/errors
// @ts-expect-error - React internal flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
