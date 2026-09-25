/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

const h = vi.hoisted(() => ({
  hardwareData: {
    cpu: { name: 'Intel i9', arch: 'x86_64', core_count: 16 },
    total_memory: 32768,
    gpus: [] as any[],
  },
  systemUsage: { cpu: 42.5, used_memory: 16384, gpus: [] as any[] },
  updateSystemUsage: vi.fn(),
  getSystemUsage: vi.fn(),
  getSystemSnapshot: vi.fn(),
  sidebar: null as null | object,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/system-monitor' }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && 'count' in opts ? `${key}:${opts.count}` : key,
  }),
}))

vi.mock('@/hooks/useHardware', () => ({
  useHardware: () => ({
    hardwareData: h.hardwareData,
    systemUsage: h.systemUsage,
    updateSystemUsage: h.updateSystemUsage,
  }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    hardware: () => ({
      getSystemUsage: h.getSystemUsage,
      getSystemSnapshot: h.getSystemSnapshot,
    }),
  }),
}))

vi.mock('@/components/shell/HeaderSlot', () => ({
  useHeaderSlot: () => h.sidebar,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: any) => (
    <div data-testid="context-bar">{children}</div>
  ),
}))

vi.mock('@/lib/utils', () => ({
  formatMegaBytes: (mb: number) => `${mb}MB`,
  cn: (...c: any[]) => c.filter(Boolean).join(' '),
}))

vi.mock('@/utils/number', () => ({
  toNumber: (n: number) => (isNaN(n) ? 0 : n),
}))

vi.mock('@/constants/routes', () => ({
  route: { systemMonitor: '/system-monitor' },
}))

import { Route } from '../system-monitor'

const renderComponent = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

describe('SystemMonitor route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).IS_MACOS = false
    h.hardwareData = {
      cpu: { name: 'Intel i9', arch: 'x86_64', core_count: 16 },
      total_memory: 32768,
      gpus: [],
    }
    h.systemUsage = { cpu: 42.5, used_memory: 16384, gpus: [] }
    h.getSystemUsage.mockResolvedValue({ cpu: 10, used_memory: 1 })
    h.getSystemSnapshot.mockResolvedValue(null)
    h.sidebar = null
    ;(globalThis as any).IS_WINDOWS = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders title and CPU info', () => {
    renderComponent()
    expect(screen.getByText('system-monitor:title')).toBeInTheDocument()
    expect(screen.getByText('Intel i9')).toBeInTheDocument()
    expect(screen.getByText('16')).toBeInTheDocument()
    expect(screen.getByText('x86_64')).toBeInTheDocument()
    expect(screen.getByText('42.50%')).toBeInTheDocument()
  })

  it('draws its own bar in the standalone window', () => {
    renderComponent()
    expect(screen.getByTestId('system-page-bar')).toHaveTextContent(
      'system-monitor:title'
    )
    expect(screen.queryByTestId('context-bar')).not.toBeInTheDocument()
  })

  it('leaves the title to the shell breadcrumb inside the shell', () => {
    h.sidebar = {}
    renderComponent()
    expect(screen.queryByTestId('system-page-bar')).not.toBeInTheDocument()
  })

  it('exposes usage as meters with their values', () => {
    renderComponent()
    const meters = screen.getAllByRole('meter')
    expect(meters.map((m) => m.getAttribute('aria-valuenow'))).toEqual([
      '43',
      '50',
    ])
  })

  it('renders RAM info with used/available and percentage', () => {
    renderComponent()
    expect(screen.getByText('32768MB')).toBeInTheDocument()
    expect(screen.getAllByText('16384MB').length).toBe(2) // both available & used are 16384
    // ram percentage = 16384/32768 * 100 = 50
    expect(screen.getByText('50.00%')).toBeInTheDocument()
  })

  it('shows noGpus message on non-mac when no GPUs reported', () => {
    renderComponent()
    expect(screen.getByText('system-monitor:noGpus')).toBeInTheDocument()
    expect(screen.getByText('system-monitor:gpus')).toBeInTheDocument()
  })

  it('renders GPUs from hardware data with backend and usage', () => {
    h.hardwareData.gpus = [
      {
        uuid: 'uuid-0',
        name: 'RTX 4090',
        total_memory: 24576,
        vendor: 'NVIDIA',
        driver_version: '560.35',
        nvidia_info: { index: 0, compute_capability: '8.9' },
        vulkan_info: { index: 0, api_version: '1.3' },
      },
      {
        uuid: 'uuid-1',
        name: 'Radeon RX 7800',
        total_memory: 16384,
        vendor: 'AMD',
        driver_version: '',
        nvidia_info: { index: -1, compute_capability: '' },
        vulkan_info: { index: 1, api_version: '1.3.290' },
      },
    ]
    h.systemUsage.gpus = [
      { uuid: 'uuid-0', used_memory: 6144, total_memory: 24576 },
    ]
    renderComponent()
    expect(screen.getByText('RTX 4090')).toBeInTheDocument()
    expect(screen.getByText('Radeon RX 7800')).toBeInTheDocument()
    expect(screen.getByText('CUDA')).toBeInTheDocument()
    expect(screen.getByText('Vulkan')).toBeInTheDocument()
    expect(screen.getByText('24576MB')).toBeInTheDocument()
    expect(screen.getByText('560.35')).toBeInTheDocument()
    // 6144/24576 = 25%
    expect(screen.getByText('25.00%')).toBeInTheDocument()
  })

  it('hides GPU card on macOS', () => {
    ;(globalThis as any).IS_MACOS = true
    renderComponent()
    expect(screen.queryByText('system-monitor:gpus')).not.toBeInTheDocument()
  })

  it('polls getSystemUsage every 5s and calls updateSystemUsage', async () => {
    vi.useFakeTimers()
    h.getSystemUsage.mockResolvedValue({ cpu: 55, used_memory: 2 })
    renderComponent()
    await vi.advanceTimersByTimeAsync(5100)
    expect(h.getSystemUsage).toHaveBeenCalled()
    expect(h.updateSystemUsage).toHaveBeenCalledWith({ cpu: 55, used_memory: 2 })
  })

  it('does not call updateSystemUsage when polling returns falsy', async () => {
    vi.useFakeTimers()
    h.getSystemUsage.mockResolvedValue(null)
    renderComponent()
    await vi.advanceTimersByTimeAsync(5100)
    expect(h.getSystemUsage).toHaveBeenCalled()
    expect(h.updateSystemUsage).not.toHaveBeenCalled()
  })

  it('handles polling errors gracefully', async () => {
    vi.useFakeTimers()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.getSystemUsage.mockRejectedValue(new Error('usage fail'))
    renderComponent()
    await vi.advanceTimersByTimeAsync(5100)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('clears interval on unmount', () => {
    vi.useFakeTimers()
    const clearSpy = vi.spyOn(global, 'clearInterval')
    const { unmount } = renderComponent()
    unmount()
    expect(clearSpy).toHaveBeenCalled()
  })

  describe('with a system snapshot', () => {
    const GB = 1024 ** 3
    const snap = (over: Record<string, any> = {}) => ({
      host_name: 'workstation',
      os_version: 'Windows 11 Pro',
      kernel_version: '26100',
      uptime_secs: 3 * 86400 + 2 * 3600 + 5 * 60,
      timestamp_ms: 10_000,
      cpu: {
        name: 'Intel i9',
        frequency_mhz: 3600,
        physical_cores: 8,
        logical_cores: 4,
        usage: 30,
        per_core: [10, 20, 30, 95],
      },
      memory: { total: 32 * GB, used: 16 * GB, swap_total: 8 * GB, swap_used: 2 * GB },
      disks: [
        {
          name: 'System',
          mount_point: 'C:/',
          file_system: 'NTFS',
          kind: 'SSD',
          total: 100 * GB,
          available: 25 * GB,
          removable: false,
        },
        {
          name: 'USB',
          mount_point: 'E:/',
          file_system: 'exFAT',
          kind: 'Unknown',
          total: 64 * GB,
          available: 64 * GB,
          removable: true,
        },
      ],
      networks: [
        { name: 'Ethernet', mac_address: '12:34:56:78:9a:bc', total_received: 1000, total_transmitted: 500 },
        { name: 'vEthernet (WSL)', mac_address: '00:15:5d:00:00:01', total_received: 0, total_transmitted: 0 },
      ],
      sensors: [],
      ...over,
    })

    it('shows system, drive, swap and CPU details', async () => {
      h.getSystemSnapshot.mockResolvedValue(snap())
      renderComponent()
      expect(await screen.findByText('workstation')).toBeInTheDocument()
      expect(screen.getByText('Windows 11 Pro')).toBeInTheDocument()
      expect(screen.getByText('3d 2h 5m')).toBeInTheDocument()
      expect(screen.getByText('3.60 GHz')).toBeInTheDocument()
      expect(screen.getByText('8')).toBeInTheDocument()
      expect(screen.getByText('NTFS')).toBeInTheDocument()
      expect(screen.getByText('SSD')).toBeInTheDocument()
      expect(screen.getByText('system-monitor:removable')).toBeInTheDocument()
      expect(screen.getByText('75.00%')).toBeInTheDocument()
      expect(screen.getByText('2.0 GB / 8.0 GB')).toBeInTheDocument()
      expect(screen.getByText('25.00%')).toBeInTheDocument()
    })

    it('keeps per-core usage collapsed until expanded', async () => {
      h.getSystemSnapshot.mockResolvedValue(snap())
      renderComponent()
      const toggle = await screen.findByRole('button', {
        name: 'system-monitor:perCore',
      })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('95%')).not.toBeInTheDocument()
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText('95%')).toBeInTheDocument()
      expect(screen.getAllByLabelText('system-monitor:coreN')).toHaveLength(4)
    })

    it('hides virtual adapters until the toggle is on', async () => {
      h.getSystemSnapshot.mockResolvedValue(snap())
      renderComponent()
      expect(await screen.findByText('Ethernet')).toBeInTheDocument()
      expect(screen.queryByText('vEthernet (WSL)')).not.toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('system-monitor:showVirtual:1'))
      expect(screen.getByText('vEthernet (WSL)')).toBeInTheDocument()
    })

    it('computes network rates between polls', async () => {
      vi.useFakeTimers()
      h.getSystemSnapshot.mockResolvedValueOnce(snap())
      h.getSystemSnapshot.mockResolvedValueOnce(
        snap({
          timestamp_ms: 15_000,
          networks: [
            { name: 'Ethernet', mac_address: '12:34:56:78:9a:bc', total_received: 1000 + 5 * 2048, total_transmitted: 500 },
          ],
        })
      )
      renderComponent()
      await vi.advanceTimersByTimeAsync(5100)
      expect(screen.getByText('2.0 KB/s')).toBeInTheDocument()
      expect(screen.getByText('0 B/s')).toBeInTheDocument()
      // The first rate is the peak so far: full bar for download, empty upload.
      expect(
        screen.getByRole('meter', { name: 'system-monitor:download' })
      ).toHaveAttribute('aria-valuenow', '100')
      expect(
        screen.getByRole('meter', { name: 'system-monitor:upload' })
      ).toHaveAttribute('aria-valuenow', '0')
    })

    it('explains missing sensors on Windows', async () => {
      ;(globalThis as any).IS_WINDOWS = true
      h.getSystemSnapshot.mockResolvedValue(snap())
      renderComponent()
      expect(
        await screen.findByText('system-monitor:noSensorsWindows')
      ).toBeInTheDocument()
    })

    it('lists sensors with current, max and critical', async () => {
      h.getSystemSnapshot.mockResolvedValue(
        snap({
          sensors: [
            { label: 'CPU Package', kind: 'cpu', source: 'sysinfo', temperature: 61.4, max: 80, critical: 100 },
            { label: 'Samsung SSD', kind: 'disk', source: 'Storage reliability counter', temperature: 76, max: 80, critical: null },
            { label: 'Unreadable', kind: 'other', source: 'sysinfo', temperature: null, max: null, critical: null },
          ],
        })
      )
      renderComponent()
      expect(await screen.findByText('CPU Package')).toBeInTheDocument()
      expect(screen.getByText('61 °C')).toBeInTheDocument()
      expect(screen.getByText(/80 °C/)).toBeInTheDocument()
      expect(screen.getByText('Storage reliability counter')).toBeInTheDocument()
      expect(screen.queryByText('Unreadable')).not.toBeInTheDocument()
      // Meters: CPU against critical (61/100), drive against max (76/80 = 95%, hot).
      const cpu = screen.getByRole('meter', { name: 'system-monitor:ofCritical' })
      expect(cpu).toHaveAttribute('aria-valuenow', '61')
      const drive = screen.getByRole('meter', { name: 'system-monitor:ofMax' })
      expect(drive).toHaveAttribute('aria-valuenow', '95')
      expect(drive.firstElementChild?.className).toContain('--destructive')
    })

    it('notes missing CPU temperatures on Windows when only a GPU reports', async () => {
      ;(globalThis as any).IS_WINDOWS = true
      h.getSystemSnapshot.mockResolvedValue(
        snap({
          sensors: [
            { label: 'RTX 4090', kind: 'gpu', source: 'NVML', temperature: 50, max: null, critical: 90 },
          ],
        })
      )
      renderComponent()
      expect(await screen.findByText('RTX 4090')).toBeInTheDocument()
      expect(
        screen.getByText('system-monitor:noCpuSensorsWindows')
      ).toBeInTheDocument()
    })

    it('lays drives out as cards with a usage meter each', async () => {
      h.getSystemSnapshot.mockResolvedValue(snap())
      renderComponent()
      const cards = await screen.findAllByTestId('drive-card')
      expect(cards).toHaveLength(2)
      expect(cards[0]).toHaveTextContent('75.0 GB / 100.0 GB')
      expect(cards[0].parentElement?.className).toContain('md:grid-cols-2')
    })

    it('does not poll while the page is hidden', async () => {
      vi.useFakeTimers()
      const vis = vi
        .spyOn(document, 'visibilityState', 'get')
        .mockReturnValue('hidden')
      renderComponent()
      await vi.advanceTimersByTimeAsync(10_100)
      expect(h.getSystemUsage).not.toHaveBeenCalled()
      expect(h.getSystemSnapshot).not.toHaveBeenCalled()
      vis.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(h.getSystemUsage).toHaveBeenCalledTimes(1)
      expect(h.getSystemSnapshot).toHaveBeenCalledTimes(1)
      vis.mockRestore()
    })
  })
})
