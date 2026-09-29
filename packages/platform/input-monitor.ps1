$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class BroInputMonitor {
  delegate IntPtr Callback(int code, IntPtr wParam, IntPtr lParam);
  static Callback keyboard = Keyboard, mouse = Mouse;
  static IntPtr kh, mh;
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id, Callback cb, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  static DateTime last = DateTime.MinValue;
  static void Human() { if ((DateTime.UtcNow-last).TotalMilliseconds < 50) return; last=DateTime.UtcNow; Console.WriteLine("{\"type\":\"human\"}"); }
  static IntPtr Keyboard(int code, IntPtr w, IntPtr p) { if(code>=0 && (Marshal.ReadInt32(p,8)&0x10)==0) Human(); return CallNextHookEx(kh,code,w,p); }
  static IntPtr Mouse(int code, IntPtr w, IntPtr p) { if(code>=0 && (Marshal.ReadInt32(p,12)&0x01)==0) Human(); return CallNextHookEx(mh,code,w,p); }
  public static void Run() {
    kh=SetWindowsHookEx(13,keyboard,GetModuleHandle(null),0);mh=SetWindowsHookEx(14,mouse,GetModuleHandle(null),0);
    if(kh==IntPtr.Zero || mh==IntPtr.Zero) throw new Exception("无法建立用户输入监控");
    Console.WriteLine("{\"type\":\"ready\"}");
    try { Application.Run(); } finally { UnhookWindowsHookEx(kh);UnhookWindowsHookEx(mh); }
  }
}
'@
[BroInputMonitor]::Run()
