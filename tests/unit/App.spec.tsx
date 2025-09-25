import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';

describe('App', () => {
  it('renders the project selection call-to-action by default', async () => {
    render(<App />);
    const button = await screen.findByRole('button', { name: /choose project folder/i });
    expect(button).toBeVisible();
  });
});
