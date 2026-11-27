import { ResultTask } from 'resultar'
import { describe, expect, it, vi } from 'vite-plus/test'

import { build } from './helpers/helper.js'

describe('MongoDB startup provisioning', () => {
  it('allows startup after provisioning finishes', async () => {
    const provision = vi.fn(() => ResultTask.ok(undefined))
    const app = await build({
      enforceStartupProvisioning: true,
      mongoPaprProvisioningService: { provision },
    })

    try {
      expect(provision).toHaveBeenCalledOnce()
    } finally {
      await app.close()
    }
  })

  it('aborts startup when provisioning fails', async () => {
    const provision = vi.fn(() => ResultTask.err(new Error('MongoDB is unavailable')))

    await expect(
      build({ enforceStartupProvisioning: true, mongoPaprProvisioningService: { provision } }),
    ).rejects.toThrow('MongoDB is unavailable')
    expect(provision).toHaveBeenCalledOnce()
  })
})
