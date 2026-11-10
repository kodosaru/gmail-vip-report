"""Read the VIP workbook, select matching Gmail messages, and format the report."""

import base64
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses
from html.parser import HTMLParser
import json
from pathlib import Path
import posixpath
import re
import sys
from tempfile import NamedTemporaryFile
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile

SPREADSHEET = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
RELATIONSHIP_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
URL = re.compile(
    r"(?<![\w@.+-])(?:[a-z][a-z0-9+.-]*://|www\.|(?:mailto|tel|sms):)[^\s<>]+",
    re.IGNORECASE,
)
BLOCKS = set("address article aside blockquote div dl dt dd footer h1 h2 h3 h4 h5 h6 header hr li main ol p pre section table tr ul".split())


def read_mailbox(settings_path):
    try:
        root = ET.parse(settings_path).getroot()
    except ET.ParseError as error:
        raise ValueError(f"Invalid XML in settings.xml: {error}") from error
    mailboxes = root.findall("mailbox")
    address = (mailboxes[0].text or "").strip().lower() if len(mailboxes) == 1 else ""
    if root.tag != "settings" or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", address):
        raise ValueError("settings.xml must contain a single mailbox email address under <settings>.")
    return address


def workbook_rules(path):
    """Read the latest VIP List tab from the XLSX package."""
    with ZipFile(path) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheet = next(
            (s for s in workbook.findall("x:sheets/x:sheet", SPREADSHEET) if s.get("name") == "VIP List"),
            None,
        )
        if sheet is None:
            raise ValueError("The workbook has no VIP List tab.")
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        target = next(r.attrib["Target"] for r in relationships if r.get("Id") == sheet.attrib[RELATIONSHIP_ID])
        sheet_path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))

        def text(element):
            return "".join(node.text or "" for node in element.findall(".//x:t", SPREADSHEET))

        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = [text(item) for item in strings.findall("x:si", SPREADSHEET)]

        def cell_value(cell):
            value = cell.findtext("x:v", default="", namespaces=SPREADSHEET)
            if cell.get("t") == "s":
                return shared[int(value)]
            if cell.get("t") == "inlineStr":
                return text(cell)
            return value

        rows = ET.fromstring(archive.read(sheet_path)).findall("x:sheetData/x:row", SPREADSHEET)
        column = None
        rules = set()
        for row in rows:
            cells = row.findall("x:c", SPREADSHEET)
            if column is None:
                for cell in cells:
                    if cell_value(cell).strip().casefold() == "email or domain":
                        column = re.match(r"[A-Z]+", cell.attrib["r"]).group()
                        break
            else:
                for cell in cells:
                    if re.fullmatch(column + r"\d+", cell.attrib["r"]):
                        value = cell_value(cell).strip().casefold()
                        if value:
                            rules.add(value)
        if column is None:
            raise ValueError("The VIP List tab has no Email or domain header.")
        return rules


def select_messages(data, rules):
    matches = []
    for message in data["headers"]:
        received = int(message["internalDate"])
        if "INBOX" not in message["labelIds"] or not data["start"] <= received <= data["end"]:
            continue
        from_values = [
            h["value"] for h in message["payload"]["headers"] if h["name"].casefold() == "from"
        ]
        senders = [address for _, address in getaddresses(from_values) if "@" in address]
        addresses = [address.casefold() for address in senders]
        if any(address in rules or "@" + address.rsplit("@", 1)[1] in rules for address in addresses):
            matches.append({"id": message["id"], "received": received, "senders": senders})
    return sorted(matches, key=lambda item: item["received"], reverse=True)


class PlainTextHTML(HTMLParser):
    """Keep visible text, line breaks, and anchor destinations from HTML-only mail."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.pieces = []
        self.hidden = []
        self.links = []
        self.pre = False

    def newline(self):
        if self.pieces and not self.pieces[-1].endswith("\n"):
            self.pieces.append("\n")

    def handle_starttag(self, tag, attrs):
        if tag in {"head", "script", "style", "template"}:
            self.hidden.append(tag)
        if self.hidden:
            return
        attrs = dict(attrs)
        if tag in BLOCKS or tag == "br":
            self.newline()
        if tag == "pre":
            self.pre = True
        if tag == "li":
            self.pieces.append("- ")
        if tag == "a":
            self.links.append((len(self.pieces), attrs.get("href") or ""))
        if tag == "img" and attrs.get("alt"):
            self.handle_data(attrs["alt"])

    def handle_endtag(self, tag):
        if self.hidden:
            if tag == self.hidden[-1]:
                self.hidden.pop()
            return
        if tag == "a" and self.links:
            index, href = self.links.pop()
            label = "".join(self.pieces[index:]).strip()
            if href and href != label:
                self.pieces.append(f" <{href}>" if label else href)
        if tag in {"td", "th"}:
            self.pieces.append(" ")
        if tag in BLOCKS:
            self.newline()
        if tag == "pre":
            self.pre = False

    def handle_data(self, data):
        if not self.hidden:
            self.pieces.append(data if self.pre else re.sub(r"[ \t\r\n\f]+", " ", data))


def body_parts(message):
    if message.get_content_disposition() == "attachment" or message.get_filename():
        return []
    kind = message.get_content_type()
    if kind in {"text/plain", "text/html"}:
        try:
            content = message.get_content()
        except LookupError:
            content = message.get_payload(decode=True).decode("utf-8", errors="replace")
        return [(kind, content)]
    if message.get_content_maintype() != "multipart":
        return []

    children = list(message.iter_parts())
    if kind == "multipart/related" and children:
        root_id = message.get_param("start")
        root = next((part for part in children if root_id and part["Content-ID"] == root_id), children[0])
        return body_parts(root)
    if kind == "multipart/signed" and children:
        return body_parts(children[0])
    groups = [parts for part in children if (parts := body_parts(part))]
    if kind == "multipart/alternative" and groups:
        return next(
            (parts for parts in groups if any(t == "text/plain" and s.strip() for t, s in parts)),
            next((parts for parts in groups if any(s.strip() for _, s in parts)), groups[0]),
        )
    return [part for parts in groups for part in parts]


def format_message(entry):
    raw = entry["raw"]
    message = BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    subject = " ".join(str(message.get("Subject", "(no subject)")).splitlines())
    parts = body_parts(message)
    if not parts and (message.is_multipart() or message.get_content_maintype() == "text"):
        raise ValueError(f"Unable to retrieve a readable body for Gmail message {entry['id']}.")
    senders = ", ".join(entry["senders"]) or "(not present)"
    lines = [f"From: {senders}", f"{entry['date']} | {subject}"]
    for kind, content in parts:
        if kind == "text/html":
            parser = PlainTextHTML()
            parser.feed(content)
            parser.close()
            content = "\n".join(line.strip() for line in "".join(parser.pieces).split("\n"))
        lines.extend(content.replace("\r\n", "\n").replace("\r", "\n").split("\n"))
    return "\n".join(
        line for line in lines
        if line.strip() and not (line.startswith("|") and not line[1:].strip()) and not URL.search(line)
        and "notice:" not in line.casefold()
    )


def write_report(entries, output):
    sections = [format_message(entry) for entry in entries]
    report = "\n\n".join(sections) if sections else "No matching VIP emails in the last seven days."
    # Replace the old report only after the complete new report has been written.
    path = Path(output)
    temporary = None
    try:
        with NamedTemporaryFile("w", encoding="utf-8", newline="\n", dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            file.write(report + "\n")
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"count": len(entries), "output": str(path)}


if __name__ == "__main__":
    operation, path = sys.argv[1:]
    data = json.load(sys.stdin)
    try:
        if operation == "check":
            result = {"rules": len(workbook_rules(path)), "mailbox": read_mailbox(data["settingsPath"])}
        elif operation == "select":
            result = select_messages(data, workbook_rules(path))
        elif operation == "write":
            result = write_report(data, path)
        else:
            raise ValueError(f"Unknown report operation: {operation}")
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, KeyError, BadZipFile) as error:
        sys.exit(str(error))
