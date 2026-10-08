"""Print the interpreter version and pointer size, one per line.

Used by `install.ps1` to pick a usable Python. It is a file rather than `python -c "..."` on purpose:
Windows PowerShell 5.1 mangles embedded double quotes when it forwards a native command's arguments,
so Python received `print(%d.%d.%d%sys.version_info[:3])` with the quotes stripped and exited with a
syntax error, which made the installer report "no usable Python" on a machine that had one.
"""
import struct
import sys

print("%d.%d.%d" % sys.version_info[:3])
print(struct.calcsize("P") * 8)
