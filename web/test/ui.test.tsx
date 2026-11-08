// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/ui/App';
import { actions, getState, setLocatingMs } from '../src/ui/store';

beforeEach(() => {
  actions.reset();
  setLocatingMs(0);
});

describe('simulator UI', () => {
  it('renders the phone on the home screen with today\'s card and the oracle readout', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Morning crew' })).toBeInTheDocument();
    expect(screen.getByText('0 of 4 checked in')).toBeInTheDocument();
    expect(screen.getByText('in fence')).toBeInTheDocument();
    expect(screen.getByText('0 − 12 ≤ 75')).toBeInTheDocument();
  });

  it('moves the dot with the keyboard and the readout follows the rules', () => {
    render(<App />);
    const dot = screen.getByRole('application', { name: /Your GPS fix/ });
    for (let i = 0; i < 4; i++) fireEvent.keyDown(dot, { key: 'ArrowRight', shiftKey: true }); // +100 m east
    expect(getState().world.you.dx).toBe(100);
    expect(screen.getByText('out of fence')).toBeInTheDocument();
    expect(screen.getByText('100 − 12 > 75')).toBeInTheDocument();
    const ring = screen.getByRole('slider', { name: 'GPS accuracy radius' });
    fireEvent.keyDown(ring, { key: 'ArrowUp', shiftKey: true }); // ±37 m
    expect(screen.getByText('in fence')).toBeInTheDocument();
  });

  it('Boarding, a tap, Gate closed: the check-in screen reveals the verdict and the ledger shows the pool', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Check in' }));
    fireEvent.change(screen.getByLabelText(/Diego Alvarez/), { target: { value: 'no_show' } });
    fireEvent.click(screen.getByRole('button', { name: /^Next window/ }));
    expect(screen.getByRole('status')).toHaveTextContent(/Boarding/);
    const big = screen.getByRole('button', { name: 'Check in' });
    await act(async () => {
      fireEvent.click(big);
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: "You're in" })).toBeDisabled();
    expect(screen.getByText(/Counted at 8:00 AM/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Gate closed/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/today/)).toBeInTheDocument();
    expect(within(dialog).getByText('Diego missed and forfeited to the pool.')).toBeInTheDocument();
    // the ledger panel shows the stake and payout entries, and the balances sum to zero
    expect(screen.getByText('stake:inst-2026-11-09')).toBeInTheDocument();
    expect(screen.getByText('payout:inst-2026-11-09')).toBeInTheDocument();
    expect(screen.getByText(/Σ members/)).toHaveTextContent('✓');
  });

  it('refuses Approximate Location and explains what the rules would have said', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Check in' }));
    fireEvent.click(screen.getByRole('button', { name: /^Next window/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Approximate' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check in' }));
    });
    expect(screen.getByText('Precise Location is off')).toBeInTheDocument();
    expect(screen.getByText(/the rules would say Unverified/)).toBeInTheDocument();
    expect(getState().world.checkins.filter((c) => c.userId === 'you')).toHaveLength(0);
  });

  it('runs a preset to the end and shows the settle-up with Venmo-style actions', () => {
    render(<App />);
    act(() => actions.runScenarioToEnd('typical_week'));
    fireEvent.click(screen.getByRole('tab', { name: 'Settle up' }));
    expect(screen.getByText("You're owed $3.34")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm received' })[0]!);
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0);
    expect(getState().world.entries.some((e) => e.kind === 'settlement_payment')).toBe(true);
  });
});
