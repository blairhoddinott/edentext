' Accepts and rejects all changes of each c<i>.odt / c<i>.docx in $LO_REV_DIR and writes the
' paragraphs LibreOffice is left with to out.txt. Basic, as pyuno is not everywhere.
Dim Out As Integer

Sub Run1(name, cmd)
  Dim a(0) As New com.sun.star.beans.PropertyValue
  Dim none(), d, e, o, s
  a(0).Name = "Hidden" : a(0).Value = True
  d = StarDesktop.loadComponentFromURL(ConvertToURL(Environ("LO_REV_DIR") & "/" & name), "_blank", 0, a())
  createUnoService("com.sun.star.frame.DispatchHelper").executeDispatch(d.CurrentController.Frame, cmd, "", 0, none())
  s = ""
  e = d.Text.createEnumeration()
  Do While e.hasMoreElements()
    o = e.nextElement()
    s = s & "|" & o.getString()
  Loop
  Print #Out, name & " " & cmd & " " & s
  d.close(True)
End Sub

Sub Main
  Dim i, ext
  On Error GoTo Bad
  Out = FreeFile
  Open Environ("LO_REV_DIR") & "/out.txt" For Output As #Out
  For i = 0 To CInt(Environ("LO_REV_COUNT")) - 1
    For Each ext In Array(".odt", ".docx")
      Run1 "c" & i & ext, ".uno:AcceptAllTrackedChanges"
      Run1 "c" & i & ext, ".uno:RejectAllTrackedChanges"
    Next
  Next
  GoTo Done
Bad:
  Print #Out, "ERR " & Err & " " & Error$ & " line " & Erl
Done:
  Close #Out
  StarDesktop.terminate()
End Sub
