// Copyright MicroPython contributors
export const injectedImportHookCode = `
import os, uio
class _FS:
  class File(uio.IOBase):
    def __init__(self):
      self.off = 0
    def ioctl(self, request, arg):
      return 0
    def readinto(self, buf):
      buf[:] = memoryview(_injected_buf)[self.off:self.off + len(buf)]
      self.off += len(buf)
      return len(buf)
  mount = umount = chdir = lambda *args: None
  def stat(self, path):
    if path == '_injected.mpy':
      return tuple(0 for _ in range(10))
    else:
      raise OSError(-2) # ENOENT
  def open(self, path, mode):
    return self.File()
os.mount(_FS(), '/_')
os.chdir('/_')
from _injected import *
os.umount('/_')
del _injected_buf, _FS
`;
