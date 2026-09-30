// Browse on the install-location page: the standard Windows folder picker.
//
// Windows Installer's own folder list is a Windows-drawn control that cannot be
// styled, so it is not used. This is JScript, not VBScript, because VBScript is
// being removed from Windows.
//
// The chosen folder always gets its own subfolder. The uninstaller removes the
// resources folder of the install directory recursively, so a bare Documents or
// a drive root must never become the install directory.
function FlintBrowse() {
  var shell = new ActiveXObject("Shell.Application");
  // 0x51: new-style dialog with an edit box, folders only.
  var folder = shell.BrowseForFolder(0, "Choose where Flint should be installed", 0x51, "");
  if (folder) {
    var path = String(folder.Self.Path).replace(/[\\\/]+$/, "");
    var name = Session.Property("ProductName") || "Flint";
    var leaf = path.substring(path.lastIndexOf("\\") + 1);
    if (path.length > 2 && leaf.toLowerCase() === name.toLowerCase()) {
      Session.Property("INSTALLDIR") = path + "\\";
    } else {
      Session.Property("INSTALLDIR") = path + "\\" + name + "\\";
    }
  }
  return 1;
}
