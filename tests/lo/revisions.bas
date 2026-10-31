' Accepts and rejects all changes of each c<i>.odt / c<i>.docx in $LO_REV_DIR and writes the
' paragraphs LibreOffice is left with to out.txt. Basic, as pyuno is not everywhere.
Dim Out As Integer

Sub Run1(name, cmd)
  Dim a(0) As New com.sun.star.beans.PropertyValue
  Dim none(), d, e, o, s, c, ps
  a(0).Name = "Hidden" : a(0).Value = True
  d = StarDesktop.loadComponentFromURL(ConvertToURL(Environ("LO_REV_DIR") & "/" & name), "_blank", 0, a())
  createUnoService("com.sun.star.frame.DispatchHelper").executeDispatch(d.CurrentController.Frame, cmd, "", 0, none())
  s = ""
  e = d.Text.createEnumeration()
  Do While e.hasMoreElements()
    o = e.nextElement()
    If o.supportsService("com.sun.star.text.TextTable") Then
      For Each c In o.getCellNames()
        s = s & "|" & Join(Split(Join(Split(o.getCellByName(c).getString(), Chr(13)), ""), Chr(10)), "|")
      Next
    Else
      s = s & "|" & o.getString()
    End If
  Loop
  Print #Out, name & " " & cmd & " " & s
  ps = d.StyleFamilies.getByName("PageStyles").getByName(d.Text.getStart().PageStyleName)
  If ps.HeaderIsOn Then Print #Out, name & " " & cmd & "#header |" & Join(Split(Join(Split(ps.HeaderText.getString(), Chr(13)), ""), Chr(10)), "|")
  d.close(True)
End Sub

' The kinds of change LibreOffice read from a file.
Sub Kinds(name)
  Dim a(0) As New com.sun.star.beans.PropertyValue
  Dim d, e, s
  a(0).Name = "Hidden" : a(0).Value = True
  d = StarDesktop.loadComponentFromURL(ConvertToURL(Environ("LO_REV_DIR") & "/" & name), "_blank", 0, a())
  s = ""
  e = d.Redlines.createEnumeration()
  Do While e.hasMoreElements()
    s = s & "|" & e.nextElement().RedlineType
  Loop
  Print #Out, name & " Kinds " & s
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
      Kinds "c" & i & ext
    Next
  Next
  GoTo Done
Bad:
  Print #Out, "ERR " & Err & " " & Error$ & " line " & Erl
Done:
  Close #Out
  StarDesktop.terminate()
End Sub
