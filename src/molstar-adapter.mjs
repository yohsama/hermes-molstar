export const OFFLINE_VIEWER_OPTIONS = Object.freeze({
  // V1 is a local structure viewer. Keep Mol*'s core representation and
  // selection UI, but omit extensions that can fetch annotations, density,
  // validation, snapshots, or third-party content.
  extensions: [],
  customFormats: [],
  layoutShowControls: true,
  layoutShowRemoteState: false,
  layoutShowSequence: true,
  layoutShowLog: false,
  // The stock left panel is a download/import launcher. File ingress belongs
  // to the authenticated shell, so keep remote-oriented actions out of view.
  layoutShowLeftPanel: false,
  collapseLeftPanel: false,
  collapseRightPanel: false,
  volumeStreamingDisabled: true,
  volumeStreamingServer: '',
  pluginStateServer: '',
  viewportShowReset: true,
  viewportShowScreenshotControls: true,
  viewportShowControls: true,
  viewportShowExpand: false,
  viewportShowToggleFullscreen: false,
  viewportShowSelectionMode: true,
  viewportShowAnimation: false,
  viewportShowTrajectoryControls: false
})

export async function createMolstarAdapter(molstar, elementOrId) {
  if (!molstar?.Viewer?.create) throw new Error('bundled Mol* Viewer API is unavailable')
  const viewer = await molstar.Viewer.create(elementOrId, OFFLINE_VIEWER_OPTIONS)
  let disposed = false
  let destroyed = false
  let activeLoads = 0

  const assertLive = () => {
    if (disposed) throw new Error('Mol* viewer is disposed')
  }

  const destroyWhenSettled = () => {
    if (disposed && activeLoads === 0 && !destroyed) {
      destroyed = true
      viewer.dispose()
    }
  }

  return {
    async load(input) {
      assertLive()
      activeLoads += 1
      try {
        await viewer.plugin.clear()
        assertLive()
        await viewer.loadStructureFromData(input.data, input.format, { dataLabel: input.name })
        assertLive()
        const hierarchy = viewer.plugin.managers.structure.hierarchy.current
        const structures = hierarchy.structures ?? []
        const atomCount = structures.reduce(
          (total, ref) => total + Number(ref?.cell?.obj?.data?.elementCount ?? 0),
          0
        )
        return {
          atomCount,
          modelCount: hierarchy.models?.length ?? 0,
          structureCount: structures.length
        }
      } finally {
        activeLoads -= 1
        destroyWhenSettled()
      }
    },
    resize() {
      if (!disposed) viewer.handleResize()
    },
    reset() {
      if (!disposed) viewer.plugin.canvas3d?.requestCameraReset()
    },
    dispose() {
      if (disposed) return
      disposed = true
      destroyWhenSettled()
    }
  }
}
