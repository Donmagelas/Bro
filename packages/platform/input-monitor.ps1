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
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  static uint dragPid;
  static bool dragging;
  static DateTime lastMove = DateTime.MinValue;
  static uint Owner(IntPtr window) { uint pid; GetWindowThreadProcessId(window, out pid); return pid; }
  static void Human(string kind, uint pid) {
    if(kind=="move") { if ((DateTime.UtcNow-lastMove).TotalMilliseconds < 50) return; lastMove=DateTime.UtcNow; }
    Console.WriteLine("{\"type\":\"human\",\"kind\":\""+kind+"\",\"pid\":"+pid+"}");
  }
  static IntPtr Keyboard(int code, IntPtr w, IntPtr p) {
    if(code>=0 && (Marshal.ReadInt32(p,8)&0x10)==0) Human("key", Owner(GetForegroundWindow()));
    return CallNextHookEx(kh,code,w,p);
  }
  static IntPtr Mouse(int code, IntPtr w, IntPtr p) {
    if(code>=0 && (Marshal.ReadInt32(p,12)&0x01)==0) {
      int message=w.ToInt32();
      Point point=new Point { X=Marshal.ReadInt32(p,0), Y=Marshal.ReadInt32(p,4) };
      uint pid=Owner(WindowFromPoint(point));
      if(message==0x201 || message==0x204 || message==0x207 || message==0x20B) { dragging=true; dragPid=pid; }
      Human(message==0x200 && !dragging ? "move" : "pointer", dragging ? dragPid : pid);
      if(message==0x202 || message==0x205 || message==0x208 || message==0x20C) dragging=false;
    }
    return CallNextHookEx(mh,code,w,p);
  }
  public static void Run() {
    kh=SetWindowsHookEx(13,keyboard,GetModuleHandle(null),0);mh=SetWindowsHookEx(14,mouse,GetModuleHandle(null),0);
    if(kh==IntPtr.Zero || mh==IntPtr.Zero) throw new Exception("无法建立用户输入监控");
    Console.WriteLine("{\"type\":\"ready\"}");
    try { Application.Run(); } finally { UnhookWindowsHookEx(kh);UnhookWindowsHookEx(mh); }
  }
}
'@
[BroInputMonitor]::Run()
