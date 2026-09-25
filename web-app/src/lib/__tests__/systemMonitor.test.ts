import { describe, it, expect } from 'vitest'
import {
  computeNetworkRates,
  diskUsedPercent,
  formatBytes,
  formatFrequency,
  formatRate,
  formatTemperature,
  formatUptime,
  interfaceKind,
  isVirtualInterface,
} from '../systemMonitor'

const net = (name: string, rx: number, tx: number) => ({
  name,
  mac_address: '12:34:56:78:9a:bc',
  total_received: rx,
  total_transmitted: tx,
})

describe('computeNetworkRates', () => {
  it('has no rates without a previous snapshot', () => {
    expect(
      computeNetworkRates(null, { timestamp_ms: 1000, networks: [net('eth0', 1, 1)] })
    ).toEqual({})
  })

  it('divides the counter delta by the elapsed seconds', () => {
    const prev = { timestamp_ms: 10_000, networks: [net('eth0', 1000, 500)] }
    const next = { timestamp_ms: 15_000, networks: [net('eth0', 6000, 1500)] }
    expect(computeNetworkRates(prev, next)).toEqual({
      eth0: { rx: 1000, tx: 200 },
    })
  })

  it('skips interfaces that were not in the previous snapshot', () => {
    const prev = { timestamp_ms: 0, networks: [net('eth0', 0, 0)] }
    const next = {
      timestamp_ms: 1000,
      networks: [net('eth0', 10, 10), net('wlan0', 99, 99)],
    }
    expect(Object.keys(computeNetworkRates(prev, next))).toEqual(['eth0'])
  })

  it('reads a counter reset as zero, not negative', () => {
    const prev = { timestamp_ms: 0, networks: [net('eth0', 5000, 5000)] }
    const next = { timestamp_ms: 1000, networks: [net('eth0', 10, 6000)] }
    expect(computeNetworkRates(prev, next).eth0).toEqual({ rx: 0, tx: 1000 })
  })

  it('returns nothing when time did not advance', () => {
    const prev = { timestamp_ms: 1000, networks: [net('eth0', 0, 0)] }
    const next = { timestamp_ms: 1000, networks: [net('eth0', 10, 10)] }
    expect(computeNetworkRates(prev, next)).toEqual({})
  })
})

describe('interface classification', () => {
  it.each([
    'lo',
    'Loopback Pseudo-Interface 1',
    'vEthernet (WSL)',
    'docker0',
    'veth12ab',
    'br-3f2a',
    'virbr0',
    'VirtualBox Host-Only Network',
    'VMware Network Adapter VMnet8',
    'utun3',
    'awdl0',
    'Tailscale',
    'Local Area Connection* 2',
  ])('treats %s as virtual', (name) => {
    expect(isVirtualInterface(name)).toBe(true)
  })

  it.each(['Ethernet', 'Wi-Fi', 'eth0', 'enp3s0', 'wlan0', 'en0'])(
    'treats %s as physical',
    (name) => {
      expect(isVirtualInterface(name)).toBe(false)
    }
  )

  it('treats an all-zero MAC as virtual', () => {
    expect(isVirtualInterface('mystery0', '00:00:00:00:00:00')).toBe(true)
  })

  it('tells Wi-Fi from Ethernet', () => {
    expect(interfaceKind('Wi-Fi')).toBe('wifi')
    expect(interfaceKind('wlp2s0')).toBe('wifi')
    expect(interfaceKind('Ethernet 2')).toBe('ethernet')
    expect(interfaceKind('eth0')).toBe('ethernet')
    expect(interfaceKind('ppp0')).toBe('other')
  })
})

describe('formatting', () => {
  it('formats bytes with binary units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
    expect(formatBytes(2 * 1024 ** 4, 2)).toBe('2.00 TB')
  })

  it('formats rates per second', () => {
    expect(formatRate(2048)).toBe('2.0 KB/s')
    expect(formatRate(0)).toBe('0 B/s')
  })

  it('formats uptime', () => {
    expect(formatUptime(30)).toBe('<1m')
    expect(formatUptime(12 * 60)).toBe('12m')
    expect(formatUptime(4 * 3600 + 12 * 60)).toBe('4h 12m')
    expect(formatUptime(3 * 86400 + 4 * 3600 + 12 * 60 + 59)).toBe('3d 4h 12m')
  })

  it('formats temperature and frequency', () => {
    expect(formatTemperature(45.6)).toBe('46 °C')
    expect(formatTemperature(null)).toBe('—')
    expect(formatFrequency(3600)).toBe('3.60 GHz')
    expect(formatFrequency(800)).toBe('800 MHz')
    expect(formatFrequency(0)).toBe('—')
  })

  it('computes disk usage share', () => {
    expect(diskUsedPercent({ total: 100, available: 25 })).toBe(75)
    expect(diskUsedPercent({ total: 0, available: 0 })).toBe(0)
    expect(diskUsedPercent({ total: 100, available: 200 })).toBe(0)
  })
})
