package desktop

import (
	"syscall"
	"unsafe"
)

// A Windows GUI executable has no console when launched from Explorer.
func ReportError(err error) {
	text, _ := syscall.UTF16PtrFromString(err.Error())
	title, _ := syscall.UTF16PtrFromString("File Transfer for DGX Sparks")
	messageBox := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	messageBox.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
}
