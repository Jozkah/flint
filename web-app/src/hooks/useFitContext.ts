import { useEffect } from 'react'
import { useHardware } from '@/hooks/useHardware'
import { useLlamacppDevices } from '@/hooks/useLlamacppDevices'
import { getServiceHub } from '@/hooks/useServiceHub'

/**
 * The machine a model is being judged against: its measured hardware and which
 * GPUs are switched on. Both are read from this computer, never from the
 * network. If startup did not measure the hardware (or it failed) it is
 * measured here, so a verdict is not left blank on a machine that can be read.
 */
export function useFitContext() {
  const hardware = useHardware((state) => state.hardwareData)
  const setHardwareData = useHardware((state) => state.setHardwareData)
  const devices = useLlamacppDevices((state) => state.devices)
  const fetchDevices = useLlamacppDevices((state) => state.fetchDevices)

  useEffect(() => {
    if (!hardware.total_memory) {
      void getServiceHub()
        .hardware()
        .getHardwareInfo()
        .then((data) => {
          if (data) setHardwareData(data)
        })
        .catch(() => {})
    }
    if (devices.length === 0) void fetchDevices().catch(() => {})
    // Once on mount: the stores update themselves after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { hardware, devices }
}
