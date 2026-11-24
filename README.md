# Ember

![Ember](assets/banner.svg)

<p align="center"><img src="assets/Ember-Stack.svg" alt="Built with HTML 65.2%, JavaScript 28.3%, Batchfile 2.6%"></p>

A local sales desk for one seller with a lot of items. It tracks what is listed where, who has written in, where each deal stands, and whose move it is. Ember by soybean_alien.

It runs only on this PC (address `127.0.0.1`, port 4319). Nothing is sent anywhere. There is no AI inside it: listings are written in chat with Claude from [PLAYBOOK.md](PLAYBOOK.md) and pasted in.

## Install

Ember needs [Node.js](https://nodejs.org) 22.5 or newer and nothing else. It has no packages to install.

- **Installer:** run `Ember-Setup-<version>.exe`. It installs for your Windows user only (no admin rights) and adds **Ember desk** and **Ember wall** to the Start menu. Setup checks for Node.js first and stops if it is missing.
- **From the source:** download or clone this repository and use the two launchers below.

To build the installer yourself, install [Inno Setup 6](https://jrsoftware.org/isinfo.php) and run `ISCC.exe installer\Ember.iss`. The file lands in `installer\Output`.

## Start it

- Double-click **Start Ember.cmd** (or **Ember desk** in the Start menu) for the desk.
- Double-click **Start Ember Wall.cmd** (or **Ember wall**) for the wall. Drag that window to the TV and double-click it for full screen.
- To stop it, close the minimized "Ember" window.
- Fill in **Pickup details** (left) once: your payment methods, meet-up spot, and town and zip.

## The desk

- **Add item** (top right): a name and an asking price make a ticket.
- **Queue** lists every ticket, most urgent first. **Board** shows the same tickets in coloured columns.
- **Your move** (top) lists every follow-up that is due. Click one to open its ticket.
- Click a ticket to open it: buyers, postings, listing text with copy buttons, photos and notes.
- There is no Save button. Each box saves when you click or tab out of it, and a "Saved" note appears at the bottom. An open ticket also picks up changes made elsewhere within about ten seconds.
- **+ Someone messaged** adds a buyer in one click. **Accepted** moves the deal to closing and copies the wrap-up message.
- **Pickup details** (left) hold the payment, meet-up spot and town used in that message.
- **Going rate** (in each ticket): **eBay sold prices** opens eBay's sold listings for the item, used condition. Type the lowest, typical and highest prices you see. Ember suggests an asking price (the typical sold price, less your **Local pickup discount** from the left menu) and shows your asking price as a percentage of typical. After 30 days it asks you to check again. Nothing is fetched automatically.
- **Tutorial** (left) walks one practice sale from start to finish. It points at each control and moves on when you use it. It starts by itself the first time Ember opens with no items, and offers to delete the practice ticket at the end.

## Where a deal can be

| Colour | Stage | What Ember asks of you |
|---|---|---|
| Grey | Draft | Post it |
| Blue | Listed | After 3 quiet days: swap in the second version |
| Orange | They contacted me | Reply and offer two pickup times |
| Yellow | They asked a question | Answer it |
| Red | They counteroffered | Send the calm asking-price reply |
| Violet | They're thinking it over | One check-in after a day |
| Ice blue | They haven't responded | One nudge after a day, then let it go |
| Lime | They accepted | Send the wrap-up message, set a time |
| Teal | Pickup set | Confirm it |
| Green | Sold | Two days later: send the thank-you and feedback message |

The stage is worked out from the buyers and postings on the ticket. Nothing is dragged by hand.

The small dot beside a buyer is the ember. It is bright orange the moment they make a move and fades over two days, so a glance shows which deals are still warm.

## Where the data is

- `data/listings.db` holds everything. `data/photos` holds the photos.
- To back up, copy the `data` folder. To start over, delete it.
- The `data` folder is never part of this repository, and uninstalling Ember leaves it in place.

## Files

- `server.js`: the whole server. Node's built-in SQLite, no packages.
- `public/index.html`: the desk. `public/wall.html`: the wall. `public/shared.js`: stages, colours and the two canned messages.
- `assets/`: the banner and its mockups.
- `installer/Ember.iss`: the Inno Setup script for the installer.
- `docs/adr/`: architecture decisions. Read them before changing how Ember is built. [ADR-0001](docs/adr/0001-no-runtime-packages.md): no runtime packages without the owner's approval.

## License

Ember by soybean_alien. Licensed under the **GPL-3.0** (see [LICENSE](LICENSE)).
